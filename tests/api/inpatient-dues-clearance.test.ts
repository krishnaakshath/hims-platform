import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionDuesClearances, admissions, auditLog, chargeLines, patients, providers, serviceCatalog } from '@/db/schema'
import { GET, POST } from '@/app/api/inpatient/admissions/[id]/dues-clearance/route'

// WS3 T5: GET (DUES_VIEW_ROLES) / POST (BILLING_AUTHORITY_ROLES) dues clearance (spec 3.2 item 13).
let sessionRole = 'billing'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'TEST_WS3T5 Billing', userId: null })) }))

const RUN = `${Date.now() % 1e8}${Math.floor(Math.random() * 1e3)}`
const PID = `TEST-WS3T5-API-${RUN}`
let admissionId = 0

const url = `http://localhost/api/inpatient/admissions/x/dues-clearance`
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const get = (id: number | string) => GET(new Request(url) as never, ctx(id))
const post = (id: number | string, body: unknown) => POST(new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never, ctx(id))

describe.skipIf(!process.env.DATABASE_URL)('/api/inpatient/admissions/[id]/dues-clearance', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS3T5 Dues Patient', dob: '1985-01-01', gender: 'female' })
    const [p] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    const [a] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: p.id }).returning()
    admissionId = a.id
    const [s] = await db.select().from(serviceCatalog).orderBy(serviceCatalog.id).limit(1)
    await db.insert(chargeLines).values({
      patientId: PID, admissionId, source: 'manual', serviceId: s.id, itemCode: s.code, itemName: s.name, serviceDate: '2099-06-01',
      quantity: 1, unitPricePaise: 350_00, priceSource: 'base', taxablePaise: 350_00, gstRateBp: 1200, hsnSac: s.hsnSac, createdByName: 'TEST_WS3T5',
    })
  })

  afterEach(() => { sessionRole = 'billing' })

  afterAll(async () => {
    const db = getDb()
    await db.delete(chargeLines).where(eq(chargeLines.patientId, PID))
    await db.delete(admissions).where(eq(admissions.patientId, PID)) // clearances cascade
    await db.delete(auditLog).where(eq(auditLog.patientId, PID))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  it('GET is gated: labs 403 with no data', async () => {
    sessionRole = 'labs'
    const res = await get(admissionId)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('GET answers the dues for frontdesk, 404 for an unknown admission, 400 for a bad id', async () => {
    sessionRole = 'frontdesk'
    const res = await get(admissionId)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dues).toMatchObject({ chargesPaise: 39_200, outstandingPaise: 39_200, creditPaise: 0 })
    expect(body.latestClearance).toBeNull()
    expect(typeof body.unpostedRoomRentDays).toBe('number')
    expect(body.roomRentPostedThrough).toBeNull()
    expect((await get(2147483000)).status).toBe(404)
    expect((await get('abc')).status).toBe(400)
  })

  it('POST by frontdesk is 403 before the body is read', async () => {
    sessionRole = 'frontdesk'
    const res = await post(admissionId, '{not json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('POST by billing with dues outstanding and no reason is 422 reason_required', async () => {
    const res = await post(admissionId, {})
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'reason_required' })
  })

  it('POST refuses unknown keys and a too-short reason with a fixed 400 that does not echo input', async () => {
    const extra = await post(admissionId, { overrideReason: 'Corporate tie-up billed monthly', secretKey: 'zzz' })
    expect(extra.status).toBe(400)
    const text = await extra.text()
    expect(text).not.toContain('secretKey')
    expect((await post(admissionId, { overrideReason: 'short' })).status).toBe(400)
  })

  it('POST by billing with a reason is 201 with the clearance; audit carries ids only', async () => {
    const reason = 'TEST_WS3T5 corporate tie-up, billed monthly'
    const res = await post(admissionId, { overrideReason: reason })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.clearance).toMatchObject({ admissionId, outstandingPaise: 39_200, overrideReason: reason })
    const rows = await getDb().select().from(admissionDuesClearances).where(eq(admissionDuesClearances.admissionId, admissionId))
    expect(rows).toHaveLength(1)
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, PID), eq(auditLog.action, 'cleared discharge dues')))
    expect(audits.map((a) => a.details)).toEqual([`admission=${admissionId} outstanding=39200`])
    expect(JSON.stringify(audits)).not.toContain('corporate')
    sessionRole = 'crc'
    const view = await (await get(admissionId)).json()
    expect(view.latestClearance).toMatchObject({ id: body.clearance.id })
  })

  it('POST for an unknown admission is 404', async () => {
    const res = await post(2147483000, {})
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'not_found' })
  })
})
