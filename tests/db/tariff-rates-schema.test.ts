import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tariffRates, servicePackageItems, serviceCatalog, departments, roomCategories, payers } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const FILE = '2026-10-07-sp2-tariff-rates.sql'

describe('tariff rates schema', () => {
  it('migration is idempotent and declares every column', () => {
    const s = readMigration(FILE)
    expect(idempotencyProblems(s)).toEqual([])
    expect(missingColumns(tariffRates, s)).toEqual([])
    expect(missingColumns(servicePackageItems, s)).toEqual([])
  })

  it('creates btree_gist and the partial inclusive-range exclusion', () => {
    const s = readMigration(FILE)
    expect(s).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist')
    expect(s).toContain('tariff_rates_no_overlap')
    expect(s).toMatch(/daterange\(valid_from, valid_to, '\[\]'\) WITH &&/)
    expect(s).toMatch(/WHERE \(deactivated_at IS NULL\)/)
    // The extension must exist before the constraint that needs it.
    expect(s.indexOf('CREATE EXTENSION IF NOT EXISTS btree_gist')).toBeLessThan(s.indexOf('ADD CONSTRAINT tariff_rates_no_overlap'))
  })

  it('pins the check, index and FK constraint names drizzle would generate', () => {
    const s = readMigration(FILE)
    for (const n of [
      'tariff_rates_amount_nonneg', 'tariff_rates_range_ordered', 'tariff_rates_scope_keys', 'tariff_rates_service_idx',
      'tariff_rates_service_id_service_catalog_id_fk', 'tariff_rates_department_id_departments_id_fk',
      'tariff_rates_payer_id_payers_id_fk', 'tariff_rates_room_category_id_room_categories_id_fk',
      'service_package_items_pkg_item_unique', 'service_package_items_qty_positive', 'service_package_items_not_self',
      'service_package_items_package_service_id_service_catalog_id_fk', 'service_package_items_item_service_id_service_catalog_id_fk',
    ]) expect(s, n).toContain(n)
  })

  // The exclusion constraint exists only in the migrations; DEPLOYING.md must
  // build a fresh database with db:migrate (baseline + migrations), not db:push.
  it('DEPLOYING.md builds a fresh database with db:migrate, which creates the exclusion constraint', () => {
    const d = readFileSync(join(process.cwd(), 'docs/DEPLOYING.md'), 'utf8')
    expect(d).toContain('tariff_rates_no_overlap')
    expect(d.indexOf('npm run db:migrate')).toBeGreaterThan(-1)
    expect(d.indexOf('npm run db:migrate')).toBeLessThan(d.indexOf('tariff_rates_no_overlap'))
  })
})

describe.skipIf(!process.env.DATABASE_URL)('tariff rates (DB)', () => {
  const ids = { rates: [] as number[], items: [] as number[], services: [] as number[], rooms: [] as number[], depts: [] as number[], payers: [] as number[] }

  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { inArray } = await import('drizzle-orm')
    const db = getDb()
    // Children first.
    if (ids.rates.length) await db.delete(tariffRates).where(inArray(tariffRates.id, ids.rates.splice(0)))
    if (ids.items.length) await db.delete(servicePackageItems).where(inArray(servicePackageItems.id, ids.items.splice(0)))
    if (ids.services.length) await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, ids.services.splice(0)))
    if (ids.rooms.length) await db.delete(roomCategories).where(inArray(roomCategories.id, ids.rooms.splice(0)))
    if (ids.payers.length) await db.delete(payers).where(inArray(payers.id, ids.payers.splice(0)))
    if (ids.depts.length) await db.delete(departments).where(inArray(departments.id, ids.depts.splice(0)))
  })

  async function fixtures() {
    const { getDb } = await import('@/db/client')
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: 'TEST_SP2_TR_D', name: 'Test SP2 Tariff Dept', kind: 'clinical' }).returning()
    ids.depts.push(d.id)
    const [s1] = await db.insert(serviceCatalog).values({ code: 'TEST_SP2_TR_S1', name: 'Test service 1', departmentId: d.id, category: 'procedure', hsnSac: '999311', gstRateBp: 0 }).returning()
    ids.services.push(s1.id)
    const [s2] = await db.insert(serviceCatalog).values({ code: 'TEST_SP2_TR_S2', name: 'Test service 2', departmentId: d.id, category: 'package', hsnSac: '999311', gstRateBp: 0 }).returning()
    ids.services.push(s2.id)
    const [rc] = await db.insert(roomCategories).values({ code: 'TEST_SP2_RC', name: 'Test room cat' }).returning()
    ids.rooms.push(rc.id)
    return { deptId: d.id, serviceId: s1.id, packageId: s2.id, roomCategoryId: rc.id }
  }

  async function makePayer() {
    const { getDb } = await import('@/db/client')
    const [p] = await getDb().insert(payers).values({ name: 'TEST_SP2_TR Payer', payerId: 'TEST_SP2_TR_P' }).returning()
    ids.payers.push(p.id)
    return p.id
  }

  async function insertRate(v: Partial<typeof tariffRates.$inferInsert> & { serviceId: number; validFrom: string }) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(tariffRates).values({ scope: 'base', amountPaise: 10000, createdByName: 'TEST_SP2', ...v }).returning()
    ids.rates.push(r.id)
    return r
  }

  async function errorOf(p: Promise<unknown>): Promise<unknown> {
    try { await p } catch (e) { return e }
    return undefined
  }

  it('rejects an overlapping base rate for the same service and dims', async () => {
    const { isExclusionViolation } = await import('@/lib/db-errors')
    const { serviceId } = await fixtures()
    await insertRate({ serviceId, validFrom: '2026-01-01', validTo: '2026-06-30' })
    const err = await errorOf(insertRate({ serviceId, validFrom: '2026-06-30', validTo: '2026-12-31' }))
    expect(isExclusionViolation(err, 'tariff_rates_no_overlap')).toBe(true)
  })

  it('treats valid_to as inclusive: the next version may start the following day', async () => {
    const { serviceId } = await fixtures()
    await insertRate({ serviceId, validFrom: '2026-01-01', validTo: '2026-06-30' })
    const r = await insertRate({ serviceId, validFrom: '2026-07-01' })
    expect(r.validTo).toBeNull()
    expect(r.currency).toBe('INR')
  })

  it('treats a null valid_to as open-ended', async () => {
    const { isExclusionViolation } = await import('@/lib/db-errors')
    const { serviceId } = await fixtures()
    await insertRate({ serviceId, validFrom: '2026-01-01' })
    const err = await errorOf(insertRate({ serviceId, validFrom: '2099-01-01', validTo: '2099-01-31' }))
    expect(isExclusionViolation(err, 'tariff_rates_no_overlap')).toBe(true)
  })

  it('allows the overlap once the first is deactivated', async () => {
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    const { serviceId } = await fixtures()
    const first = await insertRate({ serviceId, validFrom: '2026-01-01' })
    await getDb().update(tariffRates).set({ deactivatedAt: new Date() }).where(eq(tariffRates.id, first.id))
    const second = await insertRate({ serviceId, validFrom: '2026-03-01' })
    expect(second.id).toBeGreaterThan(first.id)
  })

  it('allows overlapping ranges on different dimensions (room category, ward, scope)', async () => {
    const { serviceId, roomCategoryId, deptId } = await fixtures()
    await insertRate({ serviceId, validFrom: '2026-01-01' })
    await insertRate({ serviceId, validFrom: '2026-01-01', roomCategoryId })
    await insertRate({ serviceId, validFrom: '2026-01-01', roomCategoryId, ward: 'icu' })
    await insertRate({ serviceId, validFrom: '2026-01-01', scope: 'department', departmentId: deptId })
    expect(ids.rates).toHaveLength(4)
  })

  it('rejects an overlap on the same payer and room/ward dims', async () => {
    const { isExclusionViolation } = await import('@/lib/db-errors')
    const { serviceId, roomCategoryId } = await fixtures()
    const payerId = await makePayer()
    await insertRate({ serviceId, validFrom: '2026-01-01', validTo: '2026-03-31', scope: 'payer', payerId, roomCategoryId, ward: 'icu' })
    const err = await errorOf(insertRate({ serviceId, validFrom: '2026-02-01', scope: 'payer', payerId, roomCategoryId, ward: 'icu' }))
    expect(isExclusionViolation(err, 'tariff_rates_no_overlap')).toBe(true)
  })

  it('rejects scope=payer without payer_id', async () => {
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const { serviceId } = await fixtures()
    const err = await errorOf(insertRate({ serviceId, validFrom: '2026-01-01', scope: 'payer' }))
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgConstraint(err)).toBe('tariff_rates_scope_keys')
  })

  it('rejects a reversed range and a negative amount', async () => {
    const { pgConstraint } = await import('@/lib/db-errors')
    const { serviceId } = await fixtures()
    expect(pgConstraint(await errorOf(insertRate({ serviceId, validFrom: '2026-02-01', validTo: '2026-01-31' })))).toBe('tariff_rates_range_ordered')
    expect(pgConstraint(await errorOf(insertRate({ serviceId, validFrom: '2026-02-01', amountPaise: -1 })))).toBe('tariff_rates_amount_nonneg')
  })

  it('package items: unique pair, positive quantity, not self', async () => {
    const { getDb } = await import('@/db/client')
    const { pgConstraint, isUniqueViolation } = await import('@/lib/db-errors')
    const { serviceId, packageId } = await fixtures()
    const db = getDb()
    const add = async (v: typeof servicePackageItems.$inferInsert) => {
      const [r] = await db.insert(servicePackageItems).values(v).returning()
      ids.items.push(r.id)
      return r
    }
    const ok = await add({ packageServiceId: packageId, itemServiceId: serviceId })
    expect(ok.quantity).toBe(1)
    expect(isUniqueViolation(await errorOf(add({ packageServiceId: packageId, itemServiceId: serviceId, quantity: 2 })), 'service_package_items_pkg_item_unique')).toBe(true)
    expect(pgConstraint(await errorOf(add({ packageServiceId: packageId, itemServiceId: packageId })))).toBe('service_package_items_not_self')
    expect(pgConstraint(await errorOf(add({ packageServiceId: serviceId, itemServiceId: packageId, quantity: 0 })))).toBe('service_package_items_qty_positive')
  })
})
