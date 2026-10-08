import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { roleEnum } from '@/db/schema'
import { ALL_ROLES } from '@/lib/role-policy'
import { readMigration, idempotencyProblems } from './migration-sql'

const MIGRATION = '2026-10-09-sp7-a-rcm-role.sql'

describe('SP7 rcm role', () => {
  it('roleEnum equals ALL_ROLES and ends with rcm', () => {
    expect(roleEnum.enumValues).toEqual([...ALL_ROLES])
    expect(ALL_ROLES.at(-1)).toBe('rcm')
  })

  it('rcm-role migration is idempotent and adds the value', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'rcm'/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('rcm role (DB)', () => {
  it('the database accepts the rcm role', async () => {
    const r = await getDb().execute(sql`select 'rcm'::role as r`)
    expect(r.rows[0].r).toBe('rcm')
  })
})
