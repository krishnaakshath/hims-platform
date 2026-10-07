import { describe, it, expect, afterEach } from 'vitest'
import { departments } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

describe('departments schema', () => {
  it('migration is idempotent and covers every departments column', () => {
    const sqlText = readMigration('2026-10-07-sp1-departments.sql')
    expect(idempotencyProblems(sqlText)).toEqual([]); expect(missingColumns(departments, sqlText)).toEqual([])
  })
  it('idempotencyProblems flags a bare CREATE TABLE and a DROP', () => {
    expect(idempotencyProblems('BEGIN; CREATE TABLE x (id int); DROP TABLE y; COMMIT;').length).toBe(2)
  })
  it('idempotencyProblems flags missing BEGIN/COMMIT, bare CREATE TYPE and ADD CONSTRAINT', () => {
    expect(idempotencyProblems('CREATE TYPE t AS ENUM (\'a\'); ALTER TABLE x ADD CONSTRAINT c UNIQUE (a);').length).toBe(4)
  })
  it('accepts guarded CREATE TYPE and ADD CONSTRAINT', () => {
    const s = `BEGIN;
DO $$ BEGIN CREATE TYPE t AS ENUM ('a'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c') THEN ALTER TABLE x ADD CONSTRAINT c UNIQUE (a); END IF; END $$;
COMMIT;`
    expect(idempotencyProblems(s)).toEqual([])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('departments (DB)', () => {
  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { inArray } = await import('drizzle-orm')
    await getDb().delete(departments).where(inArray(departments.code, ['TEST_SP1_A']))
  })
  it('rejects a duplicate code', async () => {
    const { createDepartment } = await import('@/lib/queries/departments')
    const { isUniqueViolation } = await import('@/lib/db-errors')
    await createDepartment({ code: 'TEST_SP1_A', name: 'Test A', kind: 'clinical' })
    let err: unknown
    try { await createDepartment({ code: 'TEST_SP1_A', name: 'Test A2', kind: 'clinical' }) } catch (e) { err = e }
    expect(isUniqueViolation(err, 'departments_code_unique')).toBe(true)
  })
})
