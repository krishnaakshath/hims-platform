// WS8 T13 (spec D17): POST /api/patients/[anonId]/archive and /restore (admin only), the detail
// GET hiding an archived chart from non-admin roles, DELETE answering 405, and the hard delete
// reachable from no route but the DPDP erase route.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { NextRequest } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { admissions, auditLog, patients, providers } from '@/db/schema'
import { formatUhid } from '@/lib/uhid'
import { deletePatient } from '@/lib/queries/patients'

let sessionRole: auth.Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `T13 ${sessionRole}`, userId: null })) }
})
import { POST as archiveRoute } from '@/app/api/patients/[anonId]/archive/route'
import { POST as restoreRoute } from '@/app/api/patients/[anonId]/restore/route'
import { GET as getPatient, DELETE as deletePatientRoute } from '@/app/api/patients/[anonId]/route'

afterEach(() => { sessionRole = 'admin' })

const stamp = Date.now()
const ID = `TEST-T13R-${stamp}`
const ADMITTED_ID = `TEST-T13RA-${stamp}`
const UHID = formatUhid('TR', 1 + (stamp % 90_000_000))
let admissionId: number

const ctx = (anonId: string) => ({ params: Promise.resolve({ anonId }) })
const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const archive = (anonId: string, body: unknown) => archiveRoute(post(`/api/patients/${anonId}/archive`, body), ctx(anonId))
const restore = (anonId: string, body: unknown = {}) => restoreRoute(post(`/api/patients/${anonId}/restore`, body), ctx(anonId))
const archivedAtOf = async (id: string) => (await getDb().select({ a: patients.archivedAt }).from(patients).where(eq(patients.id, id)))[0]?.a ?? null
const auditRows = (action: string) => getDb().select().from(auditLog).where(and(eq(auditLog.patientId, ID), eq(auditLog.action, action)))

describe.skipIf(!process.env.DATABASE_URL)('WS8 T13 archive and restore routes', () => {
  beforeAll(async () => {
    const db = getDb()
    const [provider] = await db.select({ id: providers.id }).from(providers).limit(1)
    await db.insert(patients).values([
      { id: ID, uhid: UHID, name: 'Archroute Test', dob: '1979-04-04' },
      { id: ADMITTED_ID, name: 'Archroute Admitted', dob: '1979-04-05' },
    ])
    const [adm] = await db.insert(admissions).values({ patientId: ADMITTED_ID, attendingProviderId: provider.id }).returning({ id: admissions.id })
    admissionId = adm.id
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(admissions).where(eq(admissions.id, admissionId))
    await deletePatient(ID)
    await deletePatient(ADMITTED_ID)
    await db.delete(auditLog).where(inArray(auditLog.patientId, [ID, ADMITTED_ID]))
  })

  it.each(['pi', 'crc', 'frontdesk'] as const)('%s cannot archive or restore', async (role) => {
    sessionRole = role
    expect((await archive(ID, { reason: 'Duplicate registration', confirmUhid: UHID })).status).toBe(403)
    expect((await restore(ID)).status).toBe(403)
    expect(await archivedAtOf(ID)).toBeNull()
  })

  it('400s a reason under 10 characters, an extra field and bad JSON', async () => {
    expect((await archive(ID, { reason: 'too short', confirmUhid: UHID })).status).toBe(400)
    expect((await archive(ID, { reason: 'Duplicate registration', confirmUhid: UHID, extra: 1 })).status).toBe(400)
    expect((await archive(ID, '{not json')).status).toBe(400)
    expect(await archivedAtOf(ID)).toBeNull()
  })

  it('a wrong UHID answers 400 uhid_mismatch and nothing changes', async () => {
    const res = await archive(ID, { reason: 'Duplicate registration', confirmUhid: formatUhid('TR', 99_999_999) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'uhid_mismatch' })
    expect(await archivedAtOf(ID)).toBeNull()
    expect(await auditRows('archived patient')).toHaveLength(0)
  })

  it('an admitted patient cannot be archived (409 active_admission)', async () => {
    const res = await archive(ADMITTED_ID, { reason: 'Duplicate registration', confirmUhid: ADMITTED_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'active_admission' })
    expect(await archivedAtOf(ADMITTED_ID)).toBeNull()
  })

  it('404s an unknown chart', async () => {
    expect((await archive(`${ID}-NOPE`, { reason: 'Duplicate registration', confirmUhid: UHID })).status).toBe(404)
    expect((await restore(`${ID}-NOPE`)).status).toBe(404)
  })

  it('admin archives; the audit row carries only the reason length; pi then gets 404 on the chart, admin still sees it', async () => {
    const reason = 'Duplicate registration, merged elsewhere'
    const res = await archive(ID, { reason, confirmUhid: UHID })
    expect(res.status).toBe(200)
    expect(await archivedAtOf(ID)).not.toBeNull()
    const rows = await auditRows('archived patient')
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toBe(`reason_length=${reason.length}`)
    expect(JSON.stringify(rows[0])).not.toContain('merged elsewhere')

    expect((await archive(ID, { reason, confirmUhid: UHID })).status).toBe(409)

    sessionRole = 'pi'
    expect((await getPatient(new NextRequest(`http://localhost/api/patients/${ID}`), ctx(ID))).status).toBe(404)
    sessionRole = 'admin'
    const detail = await getPatient(new NextRequest(`http://localhost/api/patients/${ID}`), ctx(ID))
    expect(detail.status).toBe(200)
    expect((await detail.json()).archiveReason).toBe(reason)
  })

  it('admin restores with an audit row; a second restore is 409', async () => {
    expect((await restore(ID, { extra: true })).status).toBe(400)
    expect((await restore(ID)).status).toBe(200)
    expect(await archivedAtOf(ID)).toBeNull()
    expect(await auditRows('restored patient')).toHaveLength(1)
    expect((await restore(ID)).status).toBe(409)
    sessionRole = 'pi'
    expect((await getPatient(new NextRequest(`http://localhost/api/patients/${ID}`), ctx(ID))).status).toBe(200)
  })
})

describe('DELETE /api/patients/[anonId] (WS8 T13)', () => {
  it('answers 405: patients are archived, not deleted', async () => {
    const res = await deletePatientRoute()
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: 'Patients are archived, not deleted. Use Archive.' })
  })

  it('no route file imports deletePatient except the DPDP erase route', () => {
    const root = join(process.cwd(), 'src/app')
    const allowed = 'src/app/api/governance/data-requests/[id]/erase/route.ts'
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name)) files.push(p)
      }
    }
    walk(root)
    const importers = files
      .filter((f) => /import\s*(type\s*)?\{[^}]*\bdeletePatient\b[^}]*\}\s*from|\bdeletePatient\s*\(|\.deletePatient\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f))
    expect(importers.filter((f) => f !== allowed)).toEqual([])
  })
})
