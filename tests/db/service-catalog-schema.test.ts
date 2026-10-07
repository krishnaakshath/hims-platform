import { describe, it, expect, afterEach } from 'vitest'
import { roomCategories, serviceCatalog, rooms, departments } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const FILE = '2026-10-07-sp2-service-catalog.sql'

describe('service catalogue schema', () => {
  it('migration is idempotent', () => {
    expect(idempotencyProblems(readMigration(FILE))).toEqual([])
  })
  it.each([['room_categories', roomCategories], ['service_catalog', serviceCatalog], ['rooms', rooms]] as const)('declares every %s column', (_n, t) => {
    // SP4: service_catalog.requires_preauth / max_quantity are added by the SP4 migration A.
    const sqlText = t === serviceCatalog ? readMigration(FILE) + readMigration('2026-10-08-sp4-a-charge-lines.sql') : readMigration(FILE)
    expect(missingColumns(t, sqlText).filter((c) => t !== rooms || c === 'room_category_id')).toEqual([])
  })
  it('pins the GST slab check and the unique codes', () => {
    const s = readMigration(FILE)
    for (const n of ['service_catalog_gst_rate_bp_allowed', 'service_catalog_code_unique', 'room_categories_code_unique', 'service_category', 'service_catalog_department_idx']) expect(s).toContain(n)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('service catalogue (DB)', () => {
  const createdServiceIds: number[] = []
  const createdDepartmentIds: number[] = []
  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { inArray } = await import('drizzle-orm')
    const db = getDb()
    if (createdServiceIds.length) await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, createdServiceIds.splice(0)))
    if (createdDepartmentIds.length) await db.delete(departments).where(inArray(departments.id, createdDepartmentIds.splice(0)))
  })

  async function makeDepartment() {
    const { getDb } = await import('@/db/client')
    const [d] = await getDb().insert(departments).values({ code: 'TEST_SP2_D', name: 'Test SP2 Dept', kind: 'clinical' }).returning()
    createdDepartmentIds.push(d.id)
    return d.id
  }

  it('rejects gst_rate_bp 1000', async () => {
    const { getDb } = await import('@/db/client')
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const departmentId = await makeDepartment()
    let err: unknown
    try {
      const [row] = await getDb().insert(serviceCatalog).values({ code: 'TEST_SP2_S1', name: 'Bad GST', departmentId, category: 'procedure', hsnSac: '999311', gstRateBp: 1000 }).returning()
      createdServiceIds.push(row.id)
    } catch (e) { err = e }
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgConstraint(err)).toBe('service_catalog_gst_rate_bp_allowed')
  })

  it('accepts an allowed slab and rejects a duplicate code', async () => {
    const { getDb } = await import('@/db/client')
    const { isUniqueViolation } = await import('@/lib/db-errors')
    const departmentId = await makeDepartment()
    const [row] = await getDb().insert(serviceCatalog).values({ code: 'TEST_SP2_S2', name: 'Dressing', departmentId, category: 'procedure', hsnSac: '999311', gstRateBp: 1800 }).returning()
    createdServiceIds.push(row.id)
    expect(row.isActive).toBe(true)
    let err: unknown
    try {
      const [dup] = await getDb().insert(serviceCatalog).values({ code: 'TEST_SP2_S2', name: 'Dup', departmentId, category: 'procedure', hsnSac: '999311' }).returning()
      createdServiceIds.push(dup.id)
    } catch (e) { err = e }
    expect(isUniqueViolation(err, 'service_catalog_code_unique')).toBe(true)
  })
})
