// WS4 T13 (spec 3.6 item 27): the lab catalogue from the tariff master.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, departments, labTests, serviceCatalog, tariffRates } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { createLabTestsFromServices, listTariffServicesWithoutTest } from '@/lib/queries/lab-catalogue'

const RUN = `${Date.now()}`
const TAG = RUN.slice(-8)
const USER = `TEST_WS4T13 q ${RUN}`
const S: Session = { role: 'admin', name: USER, userId: null }

let deptId = 0
const svc = { lab: 0, imaging: 0, procedure: 0, inactive: 0, consult: 0, mapped: 0, lab2: 0 }
let mappedTestId = 0

const testsFor = async (serviceIds: number[]) => getDb().select().from(labTests).where(inArray(labTests.serviceId, serviceIds))

describe.skipIf(!process.env.DATABASE_URL)('lab catalogue from the tariff master (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: `TQ13${TAG}`, name: 'TEST_WS4T13 dept', kind: 'diagnostic' }).returning()
    deptId = d.id
    const mk = (suffix: string, category: 'investigation_lab' | 'investigation_imaging' | 'procedure' | 'consultation', isActive = true) =>
      ({ code: `TQ13${suffix}${TAG}`, name: `TEST_WS4T13 ${suffix} ${RUN}`, departmentId: d.id, category, hsnSac: '999316', isActive })
    const rows = await db.insert(serviceCatalog).values([
      mk('L', 'investigation_lab'), mk('I', 'investigation_imaging'), mk('P', 'procedure'),
      mk('X', 'investigation_lab', false), mk('C', 'consultation'), mk('M', 'investigation_lab'), mk('K', 'investigation_lab'),
    ]).returning()
    ;[svc.lab, svc.imaging, svc.procedure, svc.inactive, svc.consult, svc.mapped, svc.lab2] = rows.map((r) => r.id)
    await db.insert(tariffRates).values({ serviceId: svc.lab, scope: 'base', amountPaise: 33300, validFrom: '2020-01-01', createdByName: 'TEST_WS4T13' })
    const [t] = await db.insert(labTests).values({ name: `TEST_WS4T13 mapped ${RUN}`, code: `TQ13-M-${RUN}`, serviceId: svc.mapped }).returning()
    mappedTestId = t.id
  })

  afterAll(async () => {
    const db = getDb()
    const ids = Object.values(svc)
    await db.delete(labTests).where(inArray(labTests.serviceId, ids))
    await db.delete(labTests).where(eq(labTests.id, mappedTestId))
    await db.delete(tariffRates).where(inArray(tariffRates.serviceId, ids))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, ids))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(auditLog).where(eq(auditLog.userName, USER))
  })

  it('lists active lab, imaging and procedure services with no test, with the base price and department', async () => {
    const list = await listTariffServicesWithoutTest()
    const ours = list.filter((c) => Object.values(svc).includes(c.serviceId))
    expect(ours.map((c) => c.serviceId).sort((a, b) => a - b)).toEqual([svc.lab, svc.imaging, svc.procedure, svc.lab2].sort((a, b) => a - b))
    expect(ours.find((c) => c.serviceId === svc.lab)).toMatchObject({ category: 'investigation_lab', departmentName: 'TEST_WS4T13 dept', basePaise: 33300 })
    expect(ours.find((c) => c.serviceId === svc.procedure)).toMatchObject({ category: 'procedure', basePaise: null })
    // Excluded: inactive, already mapped, not a lab / imaging / procedure service.
    for (const id of [svc.inactive, svc.mapped, svc.consult]) expect(list.some((c) => c.serviceId === id)).toBe(false)
  })

  it('refuses a procedure unless the admin picked it explicitly (allowProcedure), and writes nothing', async () => {
    expect(await createLabTestsFromServices([svc.lab, svc.procedure], S)).toEqual({ ok: false, error: 'category_not_orderable', serviceId: svc.procedure })
    expect(await testsFor([svc.lab, svc.procedure])).toHaveLength(0)
  })

  it('refuses a consultation even with allowProcedure', async () => {
    expect(await createLabTestsFromServices([svc.consult], S, { allowProcedure: true })).toEqual({ ok: false, error: 'category_not_orderable', serviceId: svc.consult })
  })

  it('refuses a missing or inactive service, writing nothing', async () => {
    expect(await createLabTestsFromServices([svc.lab, 2147483000], S)).toEqual({ ok: false, error: 'service_not_found', serviceId: 2147483000 })
    expect(await createLabTestsFromServices([svc.lab, svc.inactive], S)).toEqual({ ok: false, error: 'service_inactive', serviceId: svc.inactive })
    expect(await testsFor([svc.lab, svc.inactive])).toHaveLength(0)
  })

  it('refuses a service already mapped (already_has_test) and creates nothing else in the batch', async () => {
    expect(await createLabTestsFromServices([svc.lab, svc.mapped], S, { allowProcedure: true })).toEqual({ ok: false, error: 'already_has_test', serviceId: svc.mapped })
    expect(await testsFor([svc.lab])).toHaveLength(0)
    expect(await testsFor([svc.mapped])).toHaveLength(1)
  })

  it('creates one active, mapped test per service (code and name from the service; ECG-like procedure as imaging) with a count-only audit', async () => {
    const res = await createLabTestsFromServices([svc.procedure, svc.lab, svc.imaging], S, { allowProcedure: true })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.created.map((c) => c.code)).toEqual([`TQ13P${TAG}`, `TQ13L${TAG}`, `TQ13I${TAG}`])
    const rows = await testsFor([svc.procedure, svc.lab, svc.imaging])
    const by = new Map(rows.map((r) => [r.serviceId, r]))
    expect(by.get(svc.procedure)).toMatchObject({ category: 'imaging', isActive: true, name: `TEST_WS4T13 P ${RUN}`, code: `TQ13P${TAG}` })
    expect(by.get(svc.lab)).toMatchObject({ category: 'lab', isActive: true })
    expect(by.get(svc.imaging)).toMatchObject({ category: 'imaging', isActive: true })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, USER), eq(auditLog.action, 'created lab tests from tariff')))
    expect(audits.map((a) => a.details)).toEqual(['count=3'])
    // They are no longer candidates; a second attempt is refused.
    const list = await listTariffServicesWithoutTest()
    expect(list.some((c) => c.serviceId === svc.lab)).toBe(false)
    expect(await createLabTestsFromServices([svc.lab], S)).toEqual({ ok: false, error: 'already_has_test', serviceId: svc.lab })
  })

  it('two concurrent batches for the same service create exactly one test', async () => {
    const [a, b] = await Promise.all([createLabTestsFromServices([svc.lab2], S), createLabTestsFromServices([svc.lab2], S)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(await testsFor([svc.lab2])).toHaveLength(1)
  })
})
