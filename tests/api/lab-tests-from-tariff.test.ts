// WS4 T13 (spec 3.6 item 27): GET/POST /api/lab-tests/from-tariff -- LAB_SETUP_ROLES, strict body,
// a procedure (ECG) the admin picks becomes an orderable test that passes the Foundations T10 price gate.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'

let role = 'admin'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role, name: 'TEST_WS4T13 admin', userId: null })),
}))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))

import { getDb } from '@/db/client'
import { auditLog, departments, labOrders, labRequisitions, labTests, patients, providers, serviceCatalog, tariffRates } from '@/db/schema'
import { GET, POST } from '@/app/api/lab-tests/from-tariff/route'
import { POST as POST_ORDER } from '@/app/api/patients/[anonId]/lab-orders/route'
import { listLabTests } from '@/lib/queries/lab-tests'

const RUN = `${Date.now()}`
const TAG = RUN.slice(-8)
const PID = `TEST-WS4T13-${RUN}`
let deptId = 0, providerId = 0, ecgSvc = 0, mappedSvc = 0, labSvc = 0, mappedTestId = 0

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/lab-tests/from-tariff', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
const order = (labTestIds: number[]) =>
  POST_ORDER(new NextRequest(`http://localhost/api/patients/${PID}/lab-orders`, { method: 'POST', body: JSON.stringify({ labTestIds }) }), { params: Promise.resolve({ anonId: PID }) })

beforeEach(() => { role = 'admin' })

describe('role gate and body (no DB writes)', () => {
  it.each(['labs', 'pi', 'frontdesk', 'billing', 'collector'])('%s gets 403 on GET and on POST before the body is parsed', async (r) => {
    role = r
    const g = await GET()
    expect(g.status).toBe(403)
    expect(await g.json()).toEqual({ error: 'Forbidden' })
    const p = await post('{not json')
    expect(p.status).toBe(403)
    expect(await p.json()).toEqual({ error: 'Forbidden' })
  })

  it('400s an unknown key, an empty list, duplicates, more than 50 ids and a non-integer id, never echoing input', async () => {
    for (const body of [{ serviceIds: [1], extra: 'x<script>' }, { serviceIds: [] }, { serviceIds: [3, 3] }, { serviceIds: Array.from({ length: 51 }, (_, i) => i + 1) }, { serviceIds: [1.5] }, {}]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(JSON.stringify(await res.json())).not.toContain('script')
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)('from tariff (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: `TR13${TAG}`, name: 'TEST_WS4T13 cardio', kind: 'diagnostic' }).returning()
    deptId = d.id
    const [pr] = await db.insert(providers).values({ name: `TEST_WS4T13 Dr ${RUN}`, specialty: 'Cardiology', colorTag: 'chart-1', departmentId: d.id }).returning()
    providerId = pr.id
    await db.insert(patients).values({ id: PID, name: 'TEST_WS4T13 patient', dob: '1980-01-01' })
    const svcs = await db.insert(serviceCatalog).values([
      { code: `TR13E${TAG}`, name: `TEST_WS4T13 ECG ${RUN}`, departmentId: d.id, category: 'procedure', hsnSac: '999312' },
      { code: `TR13M${TAG}`, name: `TEST_WS4T13 mapped ${RUN}`, departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' },
      { code: `TR13L${TAG}`, name: `TEST_WS4T13 lab ${RUN}`, departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' },
    ]).returning()
    ;[ecgSvc, mappedSvc, labSvc] = svcs.map((s) => s.id)
    await db.insert(tariffRates).values([ecgSvc, mappedSvc, labSvc].map((serviceId) => ({ serviceId, scope: 'base' as const, amountPaise: 25000, validFrom: '2020-01-01', createdByName: 'TEST_WS4T13' })))
    const [t] = await db.insert(labTests).values({ name: `TEST_WS4T13 existing ${RUN}`, code: `TR13-X-${RUN}`, serviceId: mappedSvc }).returning()
    mappedTestId = t.id
  })

  afterAll(async () => {
    const db = getDb()
    const reqs = await db.select({ id: labOrders.requisitionId }).from(labOrders).where(eq(labOrders.patientId, PID))
    await db.delete(labOrders).where(eq(labOrders.patientId, PID))
    const reqIds = reqs.map((r) => r.id).filter((x): x is number => x !== null)
    if (reqIds.length) await db.delete(labRequisitions).where(inArray(labRequisitions.id, reqIds))
    const ids = [ecgSvc, mappedSvc, labSvc]
    await db.delete(labTests).where(inArray(labTests.serviceId, ids))
    await db.delete(labTests).where(eq(labTests.id, mappedTestId))
    await db.delete(tariffRates).where(inArray(tariffRates.serviceId, ids))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, ids))
    await db.delete(patients).where(eq(patients.id, PID))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(auditLog).where(eq(auditLog.userName, 'TEST_WS4T13 admin'))
  })

  it('GET lists the procedure and the unmapped lab service, not the mapped one', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const { candidates } = await res.json() as { candidates: { serviceId: number; basePaise: number | null }[] }
    expect(candidates.find((c) => c.serviceId === ecgSvc)).toMatchObject({ category: 'procedure', basePaise: 25000, departmentName: 'TEST_WS4T13 cardio' })
    expect(candidates.some((c) => c.serviceId === labSvc)).toBe(true)
    expect(candidates.some((c) => c.serviceId === mappedSvc)).toBe(false)
  })

  it('a service already mapped is 409 already_has_test and nothing in the batch is created', async () => {
    const res = await post({ serviceIds: [labSvc, mappedSvc] })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'A picked service already has a lab test. Refresh the list and try again.', code: 'already_has_test', serviceId: mappedSvc })
    expect(await getDb().select().from(labTests).where(eq(labTests.serviceId, labSvc))).toHaveLength(0)
  })

  it('an explicitly picked procedure (ECG) becomes an imaging test that passes the price gate and can be ordered', async () => {
    const res = await post({ serviceIds: [ecgSvc] })
    expect(res.status).toBe(201)
    const { created } = await res.json() as { created: { id: number; code: string; name: string }[] }
    expect(created).toEqual([{ id: expect.any(Number), code: `TR13E${TAG}`, name: `TEST_WS4T13 ECG ${RUN}` }])
    const listed = (await listLabTests()).find((t) => t.id === created[0].id)
    expect(listed).toMatchObject({ category: 'imaging', serviceId: ecgSvc, isActive: true, priced: true, pricePaise: 25000 })
    const placed = await order([created[0].id])
    expect(placed.status).toBe(201)
    expect((await placed.json()).lines[0]).toMatchObject({ quotedPricePaise: 25000, quoteStatus: 'quoted' })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, 'TEST_WS4T13 admin'))
    expect(audits.filter((a) => a.action === 'created lab tests from tariff').map((a) => a.details)).toEqual(['count=1'])
  })
})
