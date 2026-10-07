import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { departments } from '@/db/schema'

// Fails loudly if SP1 Task 2 drifted from what SP2 consumes.
describe('SP2 dependency on SP1 Task 2', () => {
  it('departments exposes id, code, name', () => {
    expect(Object.keys(getTableColumns(departments))).toEqual(expect.arrayContaining(['id', 'code', 'name']))
  })
  it('shared helpers exist with the consumed names', async () => {
    const money = await import('@/lib/money')
    const t = await import('@/lib/india-time')
    const e = await import('@/lib/db-errors')
    const m = await import('./migration-sql')
    expect(money.CURRENCY).toBe('INR')
    expect(typeof money.formatPaise).toBe('function')
    expect(typeof money.parseRupeesToPaise).toBe('function')
    expect(t.DEFAULT_TIMEZONE).toBe('Asia/Kolkata')
    expect(typeof t.todayIsoIn).toBe('function')
    expect(typeof e.isExclusionViolation).toBe('function')
    expect(typeof e.isUniqueViolation).toBe('function')
    expect(typeof e.pgConstraint).toBe('function')
    expect(typeof m.readMigration).toBe('function')
    expect(typeof m.idempotencyProblems).toBe('function')
    expect(typeof m.missingColumns).toBe('function')
  })
  it('department queries exist with the consumed names', async () => {
    const q = await import('@/lib/queries/departments')
    expect(typeof q.listDepartments).toBe('function')
    expect(typeof q.getDepartmentById).toBe('function')
    expect(typeof q.getDepartmentByCode).toBe('function')
  })
})
