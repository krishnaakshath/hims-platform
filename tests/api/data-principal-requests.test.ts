// WS8 T14 (spec D18): the DPDP data-principal request register -- create (due 30 days after
// receipt), checklist and status, the export bundle (FHIR + manifest, stored privately, downloaded
// through an audited route, never exposing a blob URL), and erasure that archives and scrubs when
// retention applies or deletes the chart when nothing must be kept.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { and, eq, inArray, like } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { auditLog, dataPrincipalRequests, invoices, patients } from '@/db/schema'
import { formatUhid } from '@/lib/uhid'
import { deletePatient } from '@/lib/queries/patients'

let sessionRole: auth.Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `T14 ${sessionRole}`, userId: null })) }
})
import { GET as listRoute, POST as createRoute } from '@/app/api/governance/data-requests/route'
import { GET as getRoute, PATCH as patchRoute } from '@/app/api/governance/data-requests/[id]/route'
import { POST as exportRoute } from '@/app/api/governance/data-requests/[id]/export/route'
import { GET as downloadRoute } from '@/app/api/governance/data-requests/[id]/export/download/route'
import { POST as eraseRoute } from '@/app/api/governance/data-requests/[id]/erase/route'

afterEach(() => { sessionRole = 'admin' })

const stamp = Date.now()
const KEEP_ID = `TEST-T14K-${stamp}` // has an invoice: restricted
const GONE_ID = `TEST-T14G-${stamp}` // nothing retained: erased
const KEEP_UHID = formatUhid('TR', 1 + (stamp % 90_000_000))
const GONE_UHID = formatUhid('TR', 1 + ((stamp + 7) % 90_000_000))
let dir = ''

const url = (p: string) => `http://localhost${p}`
const send = (method: 'POST' | 'PATCH', p: string, body: unknown) => new NextRequest(url(p), { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const create = (body: unknown) => createRoute(send('POST', '/api/governance/data-requests', body))
const patch = (id: number, body: unknown) => patchRoute(send('PATCH', `/api/governance/data-requests/${id}`, body), ctx(id))
const exportBundle = (id: number) => exportRoute(send('POST', `/api/governance/data-requests/${id}/export`, {}), ctx(id))
const download = (id: number) => downloadRoute(new NextRequest(url(`/api/governance/data-requests/${id}/export/download`)), ctx(id))
const erase = (id: number, body: unknown) => eraseRoute(send('POST', `/api/governance/data-requests/${id}/erase`, body), ctx(id))
const getOne = (id: number) => getRoute(new NextRequest(url(`/api/governance/data-requests/${id}`)), ctx(id))

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

async function newRequest(patientRef: string, kind: 'access' | 'erasure', receivedAt = isoDaysAgo(0)): Promise<number> {
  const res = await create({ patientRef, kind, receivedVia: 'email', receivedAt })
  expect(res.status).toBe(201)
  return (await res.json()).id
}

describe.skipIf(!process.env.DATABASE_URL)('WS8 T14 data-principal requests', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hims-ws8-t14-'))
    vi.stubEnv('BLOB_DRIVER', 'local')
    vi.stubEnv('BLOB_LOCAL_DIR', dir)
    const db = getDb()
    await db.insert(patients).values([
      { id: KEEP_ID, uhid: KEEP_UHID, name: 'Dpr Keep', dob: '1980-01-01', phone: '9876543210', email: 'keep@example.in', addressLine1: '12 MG Road', addressLine2: 'Indiranagar', portalPasswordHash: 'scrypt$x' },
      { id: GONE_ID, uhid: GONE_UHID, name: 'Dpr Gone', dob: '1981-01-01', phone: '9876543211' },
    ])
    await db.insert(invoices).values({ patientId: KEEP_ID, createdByName: 'T14 fixture' })
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    const db = getDb()
    await db.delete(dataPrincipalRequests).where(inArray(dataPrincipalRequests.patientId, [KEEP_ID, GONE_ID]))
    await db.delete(dataPrincipalRequests).where(like(dataPrincipalRequests.handledByName, 'T14 %'))
    await deletePatient(KEEP_ID).catch(() => undefined)
    await deletePatient(GONE_ID).catch(() => undefined)
    await db.delete(auditLog).where(inArray(auditLog.patientId, [KEEP_ID, GONE_ID]))
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it.each(['pi', 'crc', 'frontdesk', 'billing'] as const)('%s gets 403 on every route', async (role) => {
    sessionRole = role
    expect((await listRoute()).status).toBe(403)
    expect((await create({ patientRef: KEEP_UHID, kind: 'access', receivedVia: 'email', receivedAt: '2026-10-01' })).status).toBe(403)
    expect((await getOne(1)).status).toBe(403)
    expect((await patch(1, { status: 'in_progress' })).status).toBe(403)
    expect((await exportBundle(1)).status).toBe(403)
    expect((await download(1)).status).toBe(403)
    expect((await erase(1, { confirmUhid: KEEP_UHID })).status).toBe(403)
  })

  it('creating a request computes due_by 30 days after receipt and a DPR reference', async () => {
    const res = await create({ patientRef: KEEP_UHID.toLowerCase(), kind: 'access', receivedVia: 'letter', receivedAt: '2026-10-01', note: 'Asked by post' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.dueBy).toBe('2026-10-31')
    expect(body.reference).toMatch(/^DPR-2026-\d{6}$/)
    const [row] = await getDb().select().from(dataPrincipalRequests).where(eq(dataPrincipalRequests.id, body.id))
    expect(row.patientId).toBe(KEEP_ID)
    expect(row.status).toBe('received')
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, KEEP_ID), eq(auditLog.action, 'created data-principal request')))
    expect(audit.details).toBe(`request=${body.id} kind=access`)
  })

  it('400s an extra field, a bad date and bad JSON; 404s an unknown patient', async () => {
    expect((await create({ patientRef: KEEP_UHID, kind: 'access', receivedVia: 'email', receivedAt: '2026-10-01', extra: 1 })).status).toBe(400)
    expect((await create({ patientRef: KEEP_UHID, kind: 'access', receivedVia: 'email', receivedAt: '01/10/2026' })).status).toBe(400)
    expect((await create({ patientRef: KEEP_UHID, kind: 'deletion', receivedVia: 'email', receivedAt: '2026-10-01' })).status).toBe(400)
    expect((await create('{nope')).status).toBe(400)
    expect((await create({ patientRef: 'TR-NOPE-0', kind: 'access', receivedVia: 'email', receivedAt: '2026-10-01' })).status).toBe(404)
  })

  it('a request past due and not closed is overdue in the list; closing it clears that', async () => {
    const id = await newRequest(KEEP_UHID, 'access', isoDaysAgo(45))
    const list = await (await listRoute()).json()
    const item = list.requests.find((r: { id: number }) => r.id === id)
    expect(item).toMatchObject({ overdue: true, patientUhid: KEEP_UHID })
    expect(JSON.stringify(list)).not.toMatch(/blob|export_blob_url|exportBlobUrl/i)

    const res = await patch(id, { status: 'completed', checklist: { identity_verified: true, response_sent: true }, decisionNote: 'Records sent by email' })
    expect(res.status).toBe(200)
    const [row] = await getDb().select().from(dataPrincipalRequests).where(eq(dataPrincipalRequests.id, id))
    expect(row.closedAt).not.toBeNull()
    expect(row.checklist).toMatchObject({ identity_verified: true, response_sent: true })
    const after = await (await listRoute()).json()
    expect(after.requests.find((r: { id: number }) => r.id === id).overdue).toBe(false)
    expect((await patch(id, { checklist: { unknown_key: true } })).status).toBe(400)
  })

  it('export stores the FHIR bundle and manifest; no response carries a blob URL; download is audited', async () => {
    const id = await newRequest(KEEP_UHID, 'access')
    expect((await download(id)).status).toBe(404)

    const res = await exportBundle(id)
    expect(res.status).toBe(200)
    const exportText = await res.text()
    expect(JSON.parse(exportText)).toEqual({ ok: true })

    const [row] = await getDb().select().from(dataPrincipalRequests).where(eq(dataPrincipalRequests.id, id))
    expect(row.exportBlobUrl).toBeTruthy()
    expect(row.checklist).toMatchObject({ export_prepared: true })
    const detailText = await (await getOne(id)).text()
    expect(detailText).not.toContain(row.exportBlobUrl as string)
    expect(detailText).not.toContain(dir)
    expect(JSON.parse(detailText)).toMatchObject({ id, hasExport: true, patientUhid: KEEP_UHID })

    const dl = await download(id)
    expect(dl.status).toBe(200)
    expect(dl.headers.get('Content-Disposition')).toMatch(/^attachment; filename=".+\.json"$/)
    const bundle = JSON.parse(await dl.text())
    expect(bundle.manifest).toMatchObject({ reference: row.reference, patientUhid: KEEP_UHID })
    expect(bundle.manifest.sections).toEqual(expect.arrayContaining([{ resourceType: 'Patient', count: 1 }]))
    expect(bundle.fhir.resourceType).toBe('Bundle')
    expect(bundle.fhir.entry[0].resource.resourceType).toBe('Patient')

    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, KEEP_ID), eq(auditLog.action, 'downloaded data-principal export')))
    expect(audits).toHaveLength(1)
    expect(audits[0].details).toBe(`request=${id}`)
  })

  it('erasure with a wrong UHID is 400 and changes nothing', async () => {
    const id = await newRequest(KEEP_UHID, 'erasure')
    const res = await erase(id, { confirmUhid: GONE_UHID })
    expect(res.status).toBe(400)
    const [p] = await getDb().select({ phone: patients.phone, archivedAt: patients.archivedAt }).from(patients).where(eq(patients.id, KEEP_ID))
    expect(p).toEqual({ phone: '9876543210', archivedAt: null })
  })

  it('erasure of a patient with an invoice is restricted: archived, contact fields scrubbed, invoice kept', async () => {
    const id = await newRequest(KEEP_UHID, 'erasure')
    const res = await erase(id, { confirmUhid: KEEP_UHID })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome).toBe('restricted')
    expect(body.reasons.length).toBeGreaterThan(0)

    const [p] = await getDb().select().from(patients).where(eq(patients.id, KEEP_ID))
    expect(p.archivedAt).not.toBeNull()
    expect({ phone: p.phone, email: p.email, a1: p.addressLine1, a2: p.addressLine2, photo: p.photoBlobPath, pw: p.portalPasswordHash })
      .toEqual({ phone: null, email: null, a1: null, a2: null, photo: null, pw: null })
    expect(await getDb().select({ id: invoices.id }).from(invoices).where(eq(invoices.patientId, KEEP_ID))).toHaveLength(1)

    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, KEEP_ID), eq(auditLog.action, 'restricted patient data (DPDP erasure)')))
    expect(audit.details).toBe(`request=${id} reasons=${body.reasons.length}`)
    expect(audit.details).not.toMatch(/9876543210|example\.in|MG Road/)
  })

  it('erasure of a patient with no retained records deletes the chart; the request row stays', async () => {
    const id = await newRequest(GONE_UHID, 'erasure')
    expect((await erase(id, { confirmUhid: GONE_UHID, extra: true })).status).toBe(400)
    const res = await erase(id, { confirmUhid: GONE_UHID })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'erased' })
    expect(await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, GONE_ID))).toHaveLength(0)
    const [row] = await getDb().select().from(dataPrincipalRequests).where(eq(dataPrincipalRequests.id, id))
    expect(row.patientId).toBeNull()
    expect(row.checklist).toMatchObject({ erasure_reviewed: true })
    expect((await erase(id, { confirmUhid: GONE_UHID })).status).toBe(409)
  })
})
