// WS1 T3: POST /api/encounters/[id]/start (checked_in -> in_consultation, idempotent) and the
// workspace read model (getWorkspace never mutates). Real worktree DB; session and the doctor's
// provider resolver are mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { allergies, auditLog, encounters, patients, providers } from '@/db/schema'

let role = 'admin'
let actingProvider: { id: number; name: string } | null = null
const PROBE = `TEST_WS1T3S-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postStart } from '@/app/api/encounters/[id]/start/route'
import { getWorkspace } from '@/lib/queries/encounter-workspace'

const PATIENT = `TWS1T3S-${Date.now()}`
const start = (id: number | string, body?: string) =>
  postStart(new NextRequest(`http://localhost/api/encounters/${id}/start`, { method: 'POST', ...(body === undefined ? {} : { body }) }), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('POST /api/encounters/[id]/start (DB)', () => {
  let providerA = 0
  let providerB = 0
  const ids: number[] = []
  const mk = async (providerId: number, status: 'checked_in' | 'in_consultation' | 'completed' | 'cancelled') => {
    const [e] = await getDb().insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status, checkedInByName: PROBE }).returning()
    ids.push(e.id)
    return e.id
  }
  const statusOf = async (id: number) => (await getDb().select({ s: encounters.status }).from(encounters).where(eq(encounters.id, id)))[0]?.s

  beforeAll(async () => {
    const db = getDb()
    const [a] = await db.insert(providers).values({ name: `${PROBE} Dr A`, specialty: 'Test', colorTag: '#000000' }).returning()
    const [b] = await db.insert(providers).values({ name: `${PROBE} Dr B`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerA = a.id
    providerB = b.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS1T3 Start', dob: '1980-01-01', gender: 'female', uhid: `${PATIENT}-UH` })
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(allergies).where(eq(allergies.patientId, PATIENT))
    await db.delete(encounters).where(inArray(encounters.id, ids))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerA, providerB]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => {
    role = 'pi'
    actingProvider = { id: providerA, name: 'Dr A' }
  })

  it('moves a checked-in visit to in consultation, then answers changed:false on a repeat', async () => {
    const id = await mk(providerA, 'checked_in')
    const first = await start(id, '{}')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ status: 'in_consultation', changed: true })
    expect(await statusOf(id)).toBe('in_consultation')

    const again = await start(id) // no body at all is accepted too
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ status: 'in_consultation', changed: false })
  })

  it('audits the change with the encounter id only', async () => {
    const id = await mk(providerA, 'checked_in')
    await start(id, '{}')
    const rows = (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))).filter((r) => r.details === `encounter=${id}`)
    expect(rows.map((r) => r.action)).toContain('encounter status changed to in_consultation')
  })

  it('refuses another doctor\'s visit (403 not_owner) and leaves it checked in', async () => {
    const id = await mk(providerB, 'checked_in')
    const res = await start(id, '{}')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
    expect(await statusOf(id)).toBe('checked_in')
  })

  it('refuses frontdesk and crc before anything else (403)', async () => {
    const id = await mk(providerA, 'checked_in')
    for (const r of ['frontdesk', 'crc', 'billing']) {
      role = r
      const res = await start(id, '{}')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(await statusOf(id)).toBe('checked_in')
  })

  it('a cancelled or completed visit is 409 visit_closed', async () => {
    for (const s of ['cancelled', 'completed'] as const) {
      const id = await mk(providerA, s)
      const res = await start(id, '{}')
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Visit is closed', code: 'visit_closed' })
      expect(await statusOf(id)).toBe(s)
    }
  })

  it('admin may start any visit; unknown is 404; bad id, bad JSON or a non-empty body is 400', async () => {
    role = 'admin'
    actingProvider = null
    const id = await mk(providerB, 'checked_in')
    expect((await start(id, '{}')).status).toBe(200)
    expect((await start(2147483000, '{}')).status).toBe(404)
    expect((await start('abc', '{}')).status).toBe(400)
    expect((await start(id, '{nope')).status).toBe(400)
    expect((await start(id, JSON.stringify({ to: 'completed' }))).status).toBe(400)
  })

  it('reading the workspace of a checked-in visit never changes its status', async () => {
    const id = await mk(providerA, 'checked_in')
    const view = await getWorkspace(id, { role: 'pi', name: PROBE, userId: null } as never)
    expect(view).not.toBeNull()
    expect(view!.encounter).toMatchObject({ id, status: 'checked_in', providerId: providerA })
    expect(view!.patient).toMatchObject({ id: PATIENT, uhid: `${PATIENT}-UH`, allergyStatus: 'unknown', alerts: ['allergy_status_unknown'] })
    expect(view!.canWrite).toBe(true)
    expect(await statusOf(id)).toBe('checked_in')
    expect(await getWorkspace(2147483000, { role: 'admin', name: PROBE, userId: null } as never)).toBeNull()
  })

  it('canWrite is false for another doctor, for crc (who may still record vitals) and on a closed visit', async () => {
    const other = await mk(providerB, 'in_consultation')
    const asPi = await getWorkspace(other, { role: 'pi', name: PROBE, userId: null } as never)
    expect(asPi).toMatchObject({ canWrite: false, canRecordVitals: false })
    const asCrc = await getWorkspace(other, { role: 'crc', name: PROBE, userId: null } as never)
    expect(asCrc).toMatchObject({ canWrite: false, canRecordVitals: true })
    const done = await mk(providerA, 'completed')
    expect(await getWorkspace(done, { role: 'admin', name: PROBE, userId: null } as never)).toMatchObject({ canWrite: false, canRecordVitals: false })
  })
})
