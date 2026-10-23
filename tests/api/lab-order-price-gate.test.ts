import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'

vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role: 'admin', name: 'TEST_T10 admin', userId: null })),
}))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))

import { getDb } from '@/db/client'
import { auditLog, departments, labOrders, labRequisitions, labTests, patients, providers, serviceCatalog, tariffRates } from '@/db/schema'
import { POST } from '@/app/api/patients/[anonId]/lab-orders/route'
import { PATCH as PATCH_TEST } from '@/app/api/lab-tests/[id]/route'
import { PATCH as PATCH_SERVICE } from '@/app/api/tariff/services/[id]/route'
import { unmappedTests } from '@/lib/queries/lab-setup'

const RUN = `${Date.now()}`
const PID = `TEST-T10-${RUN}`
let deptId = 0, providerId = 0, serviceId = 0, mapped = 0, unmapped = 0

const post = (labTestIds: number[]) =>
  POST(new NextRequest(`http://localhost/api/patients/${PID}/lab-orders`, { method: 'POST', body: JSON.stringify({ labTestIds }) }), { params: Promise.resolve({ anonId: PID }) })
const patchTest = (id: number, body: unknown) =>
  PATCH_TEST(new NextRequest(`http://localhost/api/lab-tests/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })
const patchService = (id: number, body: unknown) =>
  PATCH_SERVICE(new NextRequest(`http://localhost/api/tariff/services/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })
const ordersFor = async () => getDb().select().from(labOrders).where(eq(labOrders.patientId, PID))

describe.skipIf(!process.env.DATABASE_URL)('lab order price gate (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: `TT10${RUN.slice(-8)}`, name: 'TEST_T10 dept', kind: 'diagnostic' }).returning()
    deptId = d.id
    // The route resolves the acting provider for an admin as the first ACTIVE one; make that deterministic enough.
    const [pr] = await db.insert(providers).values({ name: `TEST_T10 Dr ${RUN}`, specialty: 'Medicine', colorTag: 'chart-1', departmentId: d.id }).returning()
    providerId = pr.id
    await db.insert(patients).values({ id: PID, name: 'TEST_T10 patient', dob: '1980-01-01' })
    const [svc] = await db.insert(serviceCatalog).values({ code: `T10${RUN.slice(-8)}`, name: 'TEST_T10 CBC', departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' }).returning()
    serviceId = svc.id
    await db.insert(tariffRates).values({ serviceId, scope: 'base', amountPaise: 45000, validFrom: '2020-01-01', createdByName: 'TEST_T10' })
    const [a, b] = await db.insert(labTests).values([
      { name: `TEST_T10 mapped ${RUN}`, code: `T10-M-${RUN}`, serviceId },
      { name: `TEST_T10 unmapped ${RUN}`, code: `T10-U-${RUN}`, isActive: false },
    ]).returning()
    mapped = a.id
    unmapped = b.id
  })

  afterAll(async () => {
    const db = getDb()
    const reqs = await db.select({ id: labOrders.requisitionId }).from(labOrders).where(eq(labOrders.patientId, PID))
    await db.delete(labOrders).where(eq(labOrders.patientId, PID))
    const ids = reqs.map((r) => r.id).filter((x): x is number => x !== null)
    if (ids.length) await db.delete(labRequisitions).where(inArray(labRequisitions.id, ids))
    await db.delete(labTests).where(inArray(labTests.id, [mapped, unmapped]))
    await db.delete(tariffRates).where(eq(tariffRates.serviceId, serviceId))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, serviceId))
    await db.delete(patients).where(eq(patients.id, PID))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(auditLog).where(eq(auditLog.userName, 'TEST_T10 admin'))
  })

  it('refuses an unmapped test with 422 test_unmapped and writes nothing', async () => {
    const res = await post([unmapped])
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'This test has no price. Map it to a tariff service first.', code: 'test_unmapped' })
    expect(await ordersFor()).toHaveLength(0)
  })

  it('is all-or-nothing for a multi-test order', async () => {
    const res = await post([mapped, unmapped])
    expect(res.status).toBe(422)
    expect(await ordersFor()).toHaveLength(0)
    expect(await getDb().select().from(labRequisitions).where(eq(labRequisitions.patientId, PID))).toHaveLength(0)
  })

  it('lists the unmapped test', async () => {
    expect((await unmappedTests()).some((t) => t.id === unmapped)).toBe(true)
    expect((await unmappedTests()).some((t) => t.id === mapped)).toBe(false)
  })

  it('refuses to activate an unmapped test, then allows it once mapped', async () => {
    const refused = await patchTest(unmapped, { isActive: true })
    expect(refused.status).toBe(422)
    expect((await refused.json()).code).toBe('test_unmapped')
    const ok = await patchTest(unmapped, { serviceId, isActive: true })
    expect(ok.status).toBe(200)
  })

  it('orders a mapped test and the order carries its price', async () => {
    const res = await post([mapped])
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.lines[0]).toMatchObject({ quotedPricePaise: 45000, quoteStatus: 'quoted' })
  })

  it('refuses to unmap a test, or deactivate its service, while it has open orders', async () => {
    const unmap = await patchTest(mapped, { serviceId: null })
    expect(unmap.status).toBe(409)
    expect((await unmap.json()).code).toBe('has_open_orders')
    const deact = await patchService(serviceId, { isActive: false })
    expect(deact.status).toBe(409)
    expect((await deact.json()).error).toMatch(/open orders/)
    expect((await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, serviceId)))[0].isActive).toBe(true)
  })

  it('allows both once the orders are closed', async () => {
    await getDb().update(labOrders).set({ status: 'cancelled' }).where(eq(labOrders.patientId, PID))
    expect((await patchService(serviceId, { isActive: false })).status).toBe(200)
    expect((await patchTest(mapped, { serviceId: null })).status).toBe(200)
  })
})
void NextResponse
