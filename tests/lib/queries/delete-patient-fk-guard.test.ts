import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getDb } from '@/db/client'

// Permanent guard against the exact bug class fixed by the final
// whole-branch review of feature/care-plans: deletePatient() (in
// src/lib/queries/patients.ts) was never updated when Task 1 added
// care_plans.patient_id -- a NOT NULL FK to patients(id) with no ON DELETE
// action -- so deleting a patient with a care plan deleted their whole chart
// and then failed on the final `DELETE FROM patients` with a foreign-key
// violation, leaving a half-deleted patient with orphaned rows. The same gap
// was independently confirmed for lab_orders and medication_dispenses (two
// already-merged sibling branches) -- a third instance of the identical
// mistake in the same function.
//
// This test queries the live schema (same information_schema technique this
// codebase already uses for raw introspection, e.g.
// src/lib/queries/insurance-eligibility.ts's countEligibilityFollowUps) for
// every table with a live FK referencing patients.id, then asserts
// deletePatient()'s own source code accounts for each one -- so a fourth new
// FK added to patients without updating deletePatient() fails this test
// instead of silently corrupting data on delete.
describe('deletePatient — FK coverage guard', () => {
  it('accounts for every table with a live FK referencing patients.id', async () => {
    const result = await getDb().execute<{ table_name: string }>(sql`
      SELECT DISTINCT tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'patients'
        AND tc.table_name != 'patients'
      ORDER BY tc.table_name
    `)
    const referencingTables = result.rows.map((r) => r.table_name)
    // Sanity check on the introspection query itself -- if this list is ever
    // empty, the query broke (e.g. a Neon/Postgres information_schema
    // quirk), not that patients suddenly has zero dependents.
    expect(referencingTables.length).toBeGreaterThan(0)

    const source = readFileSync(join(process.cwd(), 'src/lib/queries/patients.ts'), 'utf-8')

    // A table is "accounted for" only if deletePatient's source actually
    // calls .delete(...)/.update(...) on it (the `rooms` table is cleared
    // via an UPDATE that nulls occupiedByPatientId, not a DELETE, matching
    // the rest of this function's real deletion calls) -- via its camelCase
    // Drizzle export name (e.g. medicationDispenses, carePlans), following
    // this codebase's snake_case-table -> camelCase-export convention used
    // throughout src/db/schema.ts, OR as a raw `DELETE FROM <table>` SQL
    // literal (e.g. lab_orders/lab_results, which live in the shared DB but
    // aren't yet declared in this branch's Drizzle schema.ts -- see the
    // comment in deletePatient). Deliberately stricter than a plain
    // substring search on the table name -- an unused import or a stray
    // comment mentioning the table must NOT count as "handled", or this
    // guard can't actually catch the bug it exists to catch.
    const toCamelCase = (snake: string) => snake.replace(/_([a-z])/g, (_match, c: string) => c.toUpperCase())

    const isAccountedFor = (table: string) => {
      const camel = toCamelCase(table)
      const deleteCall = new RegExp(`\\.delete\\(\\s*${camel}\\s*\\)`)
      const updateCall = new RegExp(`\\.update\\(\\s*${camel}\\s*\\)`)
      const rawDelete = new RegExp(`DELETE FROM ${table}\\b`, 'i')
      return deleteCall.test(source) || updateCall.test(source) || rawDelete.test(source)
    }

    const missing = referencingTables.filter((table) => !isAccountedFor(table))

    expect(missing).toEqual([])
  })
})
