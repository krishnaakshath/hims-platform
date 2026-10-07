import { describe, it, expect, afterEach, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, departments, payers, roomCategories, serviceCatalog, servicePackageItems, tariffRates } from '@/db/schema'
import { isExclusionViolation } from '@/lib/db-errors'
import { resolvePrice } from '@/lib/tariff/resolve'
import type { Session } from '@/lib/auth'
import {
  TariffOverlapError, commitRateImport, countServices, endRate, commitServiceImport, createRate, getRate, getServiceByCode, listPackageItems,
  listRatesForService, listServices, listServicesWithCurrentPrices, loadPricingContext, replacePackageItems, reviseRate,
} from '@/lib/queries/tariff'

// Real logAudit by default; a test can make the audit insert itself fail.
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit')
  return { ...actual, logAudit: vi.fn(actual.logAudit) }
})
import { logAudit } from '@/lib/audit'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP2_Q7-${RUN}`
const SESSION: Session = { role: 'billing', name: PROBE_USER, userId: null }

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try { await p } catch (e) { return e }
  return undefined
}

describe.skipIf(!process.env.DATABASE_URL)('tariff query layer (DB)', () => {
  const ids = { services: [] as number[], rooms: [] as number[], depts: [] as number[], payers: [] as number[] }

  afterEach(async () => {
    const db = getDb()
    // Children first. Every rate/item below belongs to a service this file created.
    const services = ids.services.splice(0)
    if (services.length) {
      await db.delete(tariffRates).where(inArray(tariffRates.serviceId, services))
      await db.delete(servicePackageItems).where(inArray(servicePackageItems.packageServiceId, services))
      await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, services))
    }
    if (ids.rooms.length) await db.delete(roomCategories).where(inArray(roomCategories.id, ids.rooms.splice(0)))
    if (ids.payers.length) await db.delete(payers).where(inArray(payers.id, ids.payers.splice(0)))
    if (ids.depts.length) await db.delete(departments).where(inArray(departments.id, ids.depts.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  async function fixtures() {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: 'TEST_SP2_Q7_D', name: 'Test SP2 Q7 Dept', kind: 'clinical' }).returning()
    ids.depts.push(d.id)
    const [s] = await db.insert(serviceCatalog).values({ code: 'TEST_SP2_Q7_S1', name: 'Test Q7 dressing', departmentId: d.id, category: 'procedure', hsnSac: '999311', gstRateBp: 0 }).returning()
    ids.services.push(s.id)
    const [rc] = await db.insert(roomCategories).values({ code: 'TEST_SP2_Q7PVT', name: 'Test private' }).returning()
    ids.rooms.push(rc.id)
    return { deptId: d.id, serviceId: s.id, roomCategoryId: rc.id }
  }

  async function makeService(code: string, deptId: number, category: 'procedure' | 'package' = 'procedure') {
    const [s] = await getDb().insert(serviceCatalog).values({ code, name: `Test ${code}`, departmentId: deptId, category, hsnSac: '999311', gstRateBp: 0 }).returning()
    ids.services.push(s.id)
    return s.id
  }

  async function makePayer(code: string) {
    const [p] = await getDb().insert(payers).values({ name: `Test payer ${code}`, payerId: code }).returning()
    ids.payers.push(p.id)
    return p.id
  }

  const probeAudit = () => getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))

  it('createRate throws TariffOverlapError for an overlapping base rate', async () => {
    const { serviceId } = await fixtures()
    const first = await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01', validTo: '2026-06-30' }, 'tester')
    expect(first.createdByName).toBe('tester')
    const err = await errorOf(createRate({ serviceId, scope: 'base', amountPaise: 12000, validFrom: '2026-06-30' }, 'tester'))
    expect(err).toBeInstanceOf(TariffOverlapError)
    expect((err as TariffOverlapError).conflictingRateId).toBe(first.id)
    // The next day is fine (inclusive valid_to).
    await createRate({ serviceId, scope: 'base', amountPaise: 12000, validFrom: '2026-07-01' }, 'tester')
    expect(await listRatesForService(serviceId)).toHaveLength(2)
  })

  it('stores wards normalised so case/space variants collide in the app check and at the DB exclusion', async () => {
    const { serviceId, roomCategoryId } = await fixtures()
    const r = await createRate({ serviceId, scope: 'base', roomCategoryId, ward: 'Ward A', amountPaise: 10000, validFrom: '2026-01-01' }, 'tester')
    expect(r.ward).toBe('ward a')
    expect(r.roomCategoryCode).toBe('TEST_SP2_Q7PVT')

    const appErr = await errorOf(createRate({ serviceId, scope: 'base', roomCategoryId, ward: ' ward  a ', amountPaise: 1, validFrom: '2026-03-01' }, 'tester'))
    expect(appErr).toBeInstanceOf(TariffOverlapError)

    // commitRateImport has no app-level check: the DB exclusion must reject the variant (23P01).
    const dbErr = await errorOf(commitRateImport([{ serviceId, scope: 'base', roomCategoryId, ward: ' WARD  a ', amountPaise: 1, validFrom: '2026-03-01' }], 'tester'))
    expect(isExclusionViolation(dbErr, 'tariff_rates_no_overlap')).toBe(true)
    expect(await listRatesForService(serviceId)).toHaveLength(1)
  })

  it('reviseRate closes and inserts atomically; resolver sees the new amount from effectiveFrom', async () => {
    const { serviceId } = await fixtures()
    const cur = await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01' }, 'tester')
    const { closed, created } = await reviseRate(cur.id, { amountPaise: 15000, effectiveFrom: '2026-04-01' }, 'reviser',
      { session: SESSION, action: `tariff: revised rate #${cur.id}` })
    expect(closed.id).toBe(cur.id)
    expect(closed.validTo).toBe('2026-03-31')
    expect(created.validFrom).toBe('2026-04-01')
    expect(created.validTo).toBeNull()
    expect(created.createdByName).toBe('reviser')

    const ctx = await loadPricingContext(serviceId)
    const at = (onDate: string) => resolvePrice({ serviceId, onDate }, ctx)
    expect(at('2026-03-31')).toMatchObject({ ok: true, amountPaise: 10000 })
    expect(at('2026-04-01')).toMatchObject({ ok: true, amountPaise: 15000 })
    expect((await probeAudit()).map((a) => a.action)).toEqual([`tariff: revised rate #${cur.id}`])
  })

  it('reviseRate rolls back the close (and its audit row) when the insert fails, and rejects a bad plan', async () => {
    const { serviceId } = await fixtures()
    const cur = await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01', validTo: '2026-12-31' }, 'tester')
    // Negative amount trips tariff_rates_amount_nonneg on the INSERT, after the close UPDATE ran.
    const err = await errorOf(reviseRate(cur.id, { amountPaise: -1, effectiveFrom: '2026-04-01' }, 'reviser', { session: SESSION, action: 'tariff: revised' }))
    expect(err).toBeDefined()
    expect((await getRate(cur.id))?.validTo).toBe('2026-12-31')
    expect(await listRatesForService(serviceId)).toHaveLength(1)
    expect(await probeAudit()).toEqual([])

    // A revision past the current rate's end would run into the future: rejected, nothing written.
    await expect(reviseRate(cur.id, { amountPaise: 20000, effectiveFrom: '2027-01-05' }, 'reviser')).rejects.toThrow(/ends before/)
    await expect(reviseRate(cur.id, { amountPaise: 20000, effectiveFrom: '2026-01-01' }, 'reviser')).rejects.toThrow(/start after/)
    expect((await getRate(cur.id))?.validTo).toBe('2026-12-31')
    expect(await listRatesForService(serviceId)).toHaveLength(1)
  })

  it('reviseRate fails atomically when the new version would overlap a rate already in the future', async () => {
    const { serviceId } = await fixtures()
    // Legacy rows written before wards were normalised: 'Ward A' and 'ward a' slip past the DB
    // exclusion (exact text), so a future 'ward a' row can coexist with a current 'Ward A' row.
    const db = getDb()
    const [cur] = await db.insert(tariffRates).values({ serviceId, scope: 'base', ward: 'Ward A', amountPaise: 10000, validFrom: '2026-01-01', validTo: '2026-12-31', createdByName: 'legacy' }).returning()
    await db.insert(tariffRates).values({ serviceId, scope: 'base', ward: 'ward a', amountPaise: 30000, validFrom: '2026-07-01', createdByName: 'legacy' })
    // The revision writes the normalised ward, so its new version [04-01, 12-31] overlaps the future row.
    const err = await errorOf(reviseRate(cur.id, { amountPaise: 15000, effectiveFrom: '2026-04-01' }, 'reviser', { session: SESSION, action: 'tariff: revised' }))
    expect(err instanceof TariffOverlapError || isExclusionViolation(err, 'tariff_rates_no_overlap')).toBe(true)
    expect(await listRatesForService(serviceId)).toHaveLength(2)
    expect((await getRate(cur.id))?.validTo).toBe('2026-12-31')
    expect(await probeAudit()).toEqual([])
  })

  it('loadPricingContext + resolvePrice returns the payer rate for that payer only', async () => {
    const { serviceId } = await fixtures()
    const p1 = await makePayer('TEST_SP2_Q7_P1')
    const p2 = await makePayer('TEST_SP2_Q7_P2')
    await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01' }, 'tester')
    const pr = await createRate({ serviceId, scope: 'payer', payerId: p1, amountPaise: 8000, validFrom: '2026-01-01' }, 'tester')
    expect(pr.payerName).toBe('Test payer TEST_SP2_Q7_P1')

    const ctx = await loadPricingContext(serviceId)
    expect(ctx.service?.id).toBe(serviceId)
    expect(resolvePrice({ serviceId, payerId: p1, onDate: '2026-05-01' }, ctx)).toMatchObject({ ok: true, amountPaise: 8000, scope: 'payer' })
    expect(resolvePrice({ serviceId, payerId: p2, onDate: '2026-05-01' }, ctx)).toMatchObject({ ok: true, amountPaise: 10000, scope: 'base' })
    expect(resolvePrice({ serviceId, onDate: '2026-05-01' }, ctx)).toMatchObject({ ok: true, amountPaise: 10000 })
    expect(await loadPricingContext(2_000_000_000)).toEqual({ service: null, rates: [] })
  })

  it('commitRateImport is all-or-nothing when the DB rejects one row', async () => {
    const { serviceId } = await fixtures()
    const err = await errorOf(commitRateImport([
      { serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01', validTo: '2026-06-30' },
      { serviceId, scope: 'base', amountPaise: 12000, validFrom: '2026-06-01' },
    ], 'importer', { session: SESSION, action: 'tariff: imported 2 rates' }))
    expect(isExclusionViolation(err, 'tariff_rates_no_overlap')).toBe(true)
    expect(await listRatesForService(serviceId)).toEqual([])
    expect(await probeAudit()).toEqual([])

    const n = await commitRateImport([
      { serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01', validTo: '2026-06-30' },
      { serviceId, scope: 'base', amountPaise: 12000, validFrom: '2026-07-01' },
    ], 'importer', { session: SESSION, action: 'tariff: imported 2 rates' })
    expect(n).toBe(2)
    expect(await listRatesForService(serviceId)).toHaveLength(2)
    expect(await probeAudit()).toHaveLength(1)
  })

  it('commitServiceImport inserts new codes and updates existing ones in one transaction', async () => {
    const { deptId, serviceId } = await fixtures()
    const n = await commitServiceImport([
      { code: 'TEST_SP2_Q7_S1', name: 'Renamed', departmentId: deptId, category: 'procedure', hsnSac: '999311', gstRateBp: 1800, isActive: false, existingId: serviceId },
      { code: 'TEST_SP2_Q7_S2', name: 'New one', departmentId: deptId, category: 'procedure', hsnSac: '999311', gstRateBp: 0, isActive: true, existingId: null },
    ])
    const s2 = await getServiceByCode('TEST_SP2_Q7_S2')
    if (s2) ids.services.push(s2.id)
    expect(n).toBe(2)
    expect(s2).toMatchObject({ name: 'New one', departmentCode: 'TEST_SP2_Q7_D' })
    expect(await getServiceByCode('TEST_SP2_Q7_S1')).toMatchObject({ name: 'Renamed', gstRateBp: 1800, isActive: false })

    // A failing row (unknown department FK) rolls back the whole batch.
    const err = await errorOf(commitServiceImport([
      { code: 'TEST_SP2_Q7_S3', name: 'Should vanish', departmentId: deptId, category: 'procedure', hsnSac: '999311', gstRateBp: 0, isActive: true, existingId: null },
      { code: 'TEST_SP2_Q7_S4', name: 'Bad dept', departmentId: 2_000_000_000, category: 'procedure', hsnSac: '999311', gstRateBp: 0, isActive: true, existingId: null },
    ]))
    expect(err).toBeDefined()
    expect(await getServiceByCode('TEST_SP2_Q7_S3')).toBeNull()
  })

  it('replacePackageItems swaps the item set in a transaction and keeps the old set on failure', async () => {
    const { deptId, serviceId } = await fixtures()
    const pkg = await makeService('TEST_SP2_Q7_PKG', deptId, 'package')
    const other = await makeService('TEST_SP2_Q7_S9', deptId)
    await replacePackageItems(pkg, [{ serviceId, quantity: 2 }], { session: SESSION, action: 'tariff: updated package items' })
    expect(await listPackageItems(pkg)).toEqual([{ itemServiceId: serviceId, code: 'TEST_SP2_Q7_S1', name: 'Test Q7 dressing', quantity: 2 }])

    // Second item references a non-existent service: FK error after the delete ran.
    const err = await errorOf(replacePackageItems(pkg, [{ serviceId: other, quantity: 1 }, { serviceId: 2_000_000_000, quantity: 1 }], { session: SESSION, action: 'tariff: updated package items' }))
    expect(err).toBeDefined()
    expect((await listPackageItems(pkg)).map((i) => i.itemServiceId)).toEqual([serviceId])
    expect(await probeAudit()).toHaveLength(1)

    await replacePackageItems(pkg, [])
    expect(await listPackageItems(pkg)).toEqual([])
  })

  it('listServices filters by code prefix or name substring; listServicesWithCurrentPrices resolves base and department prices', async () => {
    const { deptId, serviceId } = await fixtures()
    await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01' }, 'tester')
    await createRate({ serviceId, scope: 'department', departmentId: deptId, amountPaise: 9000, validFrom: '2026-01-01' }, 'tester')

    expect((await listServices({ q: 'test_sp2_q7' })).map((s) => s.id)).toEqual([serviceId])
    expect((await listServices({ q: 'q7 DRESS' })).map((s) => s.id)).toEqual([serviceId])
    expect(await listServices({ q: 'Q7_S1_NOPE' })).toEqual([])
    expect(await listServices({ q: '%' , departmentId: deptId })).toEqual([])
    const [row] = await listServices({ departmentId: deptId })
    expect(row).toMatchObject({ id: serviceId, departmentCode: 'TEST_SP2_Q7_D', departmentName: 'Test SP2 Q7 Dept' })

    const priced = await listServicesWithCurrentPrices({ departmentId: deptId }, '2026-05-01')
    expect(priced).toEqual([expect.objectContaining({ id: serviceId, basePaise: 10000, departmentPaise: 9000 })])
    const before = await listServicesWithCurrentPrices({ departmentId: deptId }, '2025-12-31')
    expect(before[0]).toMatchObject({ basePaise: null, departmentPaise: null })
  })

  it('countServices counts every match; listServices pages with limit and offset in code order', async () => {
    const { deptId, serviceId } = await fixtures()
    const b = await makeService('TEST_SP2_Q7_S2', deptId)
    const c = await makeService('TEST_SP2_Q7_S3', deptId)
    expect(await countServices({ departmentId: deptId })).toBe(3)
    expect(await countServices({ departmentId: deptId, q: 'TEST_SP2_Q7_S3' })).toBe(1)
    expect((await listServices({ departmentId: deptId, limit: 2 })).map((s) => s.id)).toEqual([serviceId, b])
    expect((await listServices({ departmentId: deptId, limit: 2, offset: 2 })).map((s) => s.id)).toEqual([c])
    expect((await listServicesWithCurrentPrices({ departmentId: deptId, limit: 2, offset: 2 }, '2026-05-01')).map((s) => s.id)).toEqual([c])
  })

  // ---- final-review fix wave: audit failure, locking ----

  it('when the audit insert itself fails, createRate, reviseRate and commitRateImport write nothing', async () => {
    const { serviceId, deptId } = await fixtures()
    const audit = { session: SESSION, action: 'tariff: probe' }
    const auditDown = () => vi.mocked(logAudit).mockRejectedValueOnce(new Error('audit insert failed'))

    auditDown()
    await expect(createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01' }, 'tester', audit)).rejects.toThrow('audit insert failed')
    expect(await listRatesForService(serviceId)).toEqual([])

    const cur = await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01' }, 'tester')
    auditDown()
    await expect(reviseRate(cur.id, { amountPaise: 15000, effectiveFrom: '2026-04-01' }, 'reviser', audit)).rejects.toThrow('audit insert failed')
    expect((await listRatesForService(serviceId)).map((r) => [r.id, r.validTo])).toEqual([[cur.id, null]])

    auditDown()
    await expect(commitRateImport([
      { serviceId, scope: 'payer', payerId: await makePayer('TEST_SP2_Q7_PA'), amountPaise: 1, validFrom: '2026-01-01' },
      { serviceId, scope: 'department', departmentId: deptId, amountPaise: 2, validFrom: '2026-01-01' },
    ], 'importer', audit)).rejects.toThrow('audit insert failed')
    expect(await listRatesForService(serviceId)).toHaveLength(1)
    expect(await probeAudit()).toEqual([])
  })

  it('endRate checks overlap itself, under the service lock: running into the next version is a TariffOverlapError', async () => {
    const { serviceId } = await fixtures()
    const first = await createRate({ serviceId, scope: 'base', amountPaise: 10000, validFrom: '2026-01-01', validTo: '2026-03-31' }, 'tester')
    await createRate({ serviceId, scope: 'base', amountPaise: 12000, validFrom: '2026-04-01' }, 'tester')
    const err = await errorOf(endRate(first.id, '2026-04-15', { session: SESSION, action: 'tariff: ended' }))
    expect(err).toBeInstanceOf(TariffOverlapError)
    expect((await getRate(first.id))?.validTo).toBe('2026-03-31')
    expect(await probeAudit()).toEqual([])
    expect((await endRate(first.id, '2026-02-28'))?.validTo).toBe('2026-02-28')
    expect(await endRate(2_000_000_000, '2026-02-28')).toBeNull()
  })

  /** Runs `run` while another transaction holds the service row lock; reports whether it had to wait. */
  async function whileServiceLocked<T>(serviceId: number, run: () => Promise<T>): Promise<{ waited: boolean; result: T }> {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let markLocked!: () => void
    const locked = new Promise<void>((r) => { markLocked = r })
    const holder = getDb().transaction(async (tx) => {
      await tx.select({ id: serviceCatalog.id }).from(serviceCatalog).where(eq(serviceCatalog.id, serviceId)).for('update')
      markLocked()
      await gate
    })
    await locked
    let settled = false
    const pending = run().finally(() => { settled = true })
    await new Promise((r) => setTimeout(r, 300))
    const waited = !settled
    release()
    await holder
    return { waited, result: await pending }
  }

  it('commitRateImport, endRate and replacePackageItems take the service lock (same order as createRate)', async () => {
    const { deptId, serviceId } = await fixtures()
    const s2 = await makeService('TEST_SP2_Q7_S2', deptId)
    const imp = await whileServiceLocked(s2, () => commitRateImport([
      { serviceId, scope: 'base', amountPaise: 1, validFrom: '2026-01-01', validTo: '2026-01-31' },
      { serviceId: s2, scope: 'base', amountPaise: 2, validFrom: '2026-01-01' },
    ], 'importer'))
    expect(imp).toEqual({ waited: true, result: 2 })

    const [rate] = await listRatesForService(serviceId)
    const end = await whileServiceLocked(serviceId, () => endRate(rate.id, '2026-01-15'))
    expect(end.waited).toBe(true)
    expect(end.result?.validTo).toBe('2026-01-15')

    const pkg = await makeService('TEST_SP2_Q7_PKG', deptId, 'package')
    const items = await whileServiceLocked(pkg, () => replacePackageItems(pkg, [{ serviceId, quantity: 1 }]))
    expect(items.waited).toBe(true)
    expect((await listPackageItems(pkg)).map((i) => i.itemServiceId)).toEqual([serviceId])
  })
})
