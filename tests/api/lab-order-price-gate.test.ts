import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
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
import { ServiceHasOpenLabOrdersError, commitServiceImport } from '@/lib/queries/tariff'

const RUN = `${Date.now()}`
const PID = `TEST-T10-${RUN}`
let inactiveTest = 0, noRateTest = 0, inactiveSvc = 0, noRateSvc = 0
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
    const svcs = await db.insert(serviceCatalog).values([
      { code: `T10I${RUN.slice(-7)}`, name: 'TEST_T10 inactive svc', departmentId: d.id, category: 'investigation_lab', hsnSac: '999316', isActive: false },
      { code: `T10N${RUN.slice(-7)}`, name: 'TEST_T10 no-rate svc', departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' },
    ]).returning()
    inactiveSvc = svcs[0].id; noRateSvc = svcs[1].id
    await db.insert(tariffRates).values({ serviceId: inactiveSvc, scope: 'base', amountPaise: 100, validFrom: '2020-01-01', createdByName: 'TEST_T10' })
    const tt = await db.insert(labTests).values([
      { name: `TEST_T10 inactive-svc ${RUN}`, code: `T10-I-${RUN}`, serviceId: inactiveSvc },
      { name: `TEST_T10 no-rate ${RUN}`, code: `T10-N-${RUN}`, serviceId: noRateSvc },
    ]).returning()
    inactiveTest = tt[0].id; noRateTest = tt[1].id
    unmapped = b.id
  })

  afterAll(async () => {
    const db = getDb()
    const reqs = await db.select({ id: labOrders.requisitionId }).from(labOrders).where(eq(labOrders.patientId, PID))
    await db.delete(labOrders).where(eq(labOrders.patientId, PID))
    const ids = reqs.map((r) => r.id).filter((x): x is number => x !== null)
    if (ids.length) await db.delete(labRequisitions).where(inArray(labRequisitions.id, ids))
    await db.delete(labTests).where(inArray(labTests.id, [mapped, unmapped, inactiveTest, noRateTest]))
    await db.delete(tariffRates).where(eq(tariffRates.serviceId, serviceId))
    await db.delete(tariffRates).where(eq(tariffRates.serviceId, inactiveSvc))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [serviceId, inactiveSvc, noRateSvc]))
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

  it.each([['inactive service', () => inactiveTest], ['service with no current rate', () => noRateTest]])('refuses a test mapped to an %s with 422 test_unpriced and writes nothing', async (_n, id) => {
    const res = await post([mapped, id()])
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'This test has no price. Map it to a tariff service first.', code: 'test_unpriced' })
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

  it('CSV import cannot deactivate a service with open orders, and writes nothing', async () => {
    const row = (id: number, code: string, isActive: boolean) =>
      ({ code, name: `renamed ${code}`, departmentId: deptId, category: 'investigation_lab' as const, hsnSac: '999316', gstRateBp: 0, isActive, existingId: id })
    const [svc] = await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, serviceId))
    const [other] = await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, noRateSvc))
    const err = await commitServiceImport([row(noRateSvc, other.code, false), row(serviceId, svc.code, false)]).catch((e) => e)
    expect(err).toBeInstanceOf(ServiceHasOpenLabOrdersError)
    expect(err.message).toContain(svc.code)
    const after = await getDb().select().from(serviceCatalog).where(inArray(serviceCatalog.id, [serviceId, noRateSvc]))
    expect(after.every((s) => s.isActive && !s.name.startsWith('renamed'))).toBe(true)
  })

  it('CSV import still deactivates a service with no open orders', async () => {
    const [other] = await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, noRateSvc))
    const n = await commitServiceImport([{ code: other.code, name: other.name, departmentId: deptId, category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, isActive: false, existingId: noRateSvc }])
    expect(n).toBe(1)
    expect((await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, noRateSvc)))[0].isActive).toBe(false)
  })

  it('allows both once the orders are closed', async () => {
    await getDb().update(labOrders).set({ status: 'cancelled' }).where(eq(labOrders.patientId, PID))
    expect((await patchService(serviceId, { isActive: false })).status).toBe(200)
    expect((await patchTest(mapped, { serviceId: null })).status).toBe(200)
  })
})
