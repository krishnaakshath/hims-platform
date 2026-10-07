import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { roleEnum } from '@/db/schema'
import {
  ALL_ROLES, CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, hasSearchScope,
  CODING_ROLES, CODING_ENTRY_ROLES, CODE_PROPOSE_ROLES, CODING_QUERY_RESPOND_ROLES, CODE_LOOKUP_ROLES, CODE_SYSTEM_ADMIN_ROLES,
} from '@/lib/role-policy'
import { readMigration, idempotencyProblems } from './migration-sql'

const MIGRATION = '2026-10-07-sp6-a-coder-role.sql'

describe('SP6 coder role', () => {
  it('roleEnum equals ALL_ROLES and ends with coder', () => {
    expect(roleEnum.enumValues).toEqual([...ALL_ROLES])
    expect(ALL_ROLES.at(-1)).toBe('coder')
  })

  it('coder-role migration is idempotent and adds the value', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'coder'/)
  })

  it('coder has no global search scope and no clinical/directory access', () => {
    expect(hasSearchScope('coder')).toBe(false)
    expect(CLINICAL_ROLES).not.toContain('coder')
    expect(PATIENT_DIRECTORY_ROLES).not.toContain('coder')
  })

  it('SP6 role constants match the plan table', () => {
    expect([...CODING_ROLES]).toEqual(['admin', 'coder'])
    expect([...CODING_ENTRY_ROLES]).toEqual(['admin', 'coder', 'pi'])
    expect([...CODE_PROPOSE_ROLES]).toEqual(['admin', 'pi'])
    expect([...CODING_QUERY_RESPOND_ROLES]).toEqual(['admin', 'pi', 'coder'])
    expect([...CODE_LOOKUP_ROLES]).toEqual(['admin', 'coder', 'pi', 'crc', 'billing'])
    expect([...CODE_SYSTEM_ADMIN_ROLES]).toEqual(['admin'])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('coder role (DB)', () => {
  it('the database accepts the coder role', async () => {
    const r = await getDb().execute(sql`select 'coder'::role as r`)
    expect(r.rows[0].r).toBe('coder')
  })
})
