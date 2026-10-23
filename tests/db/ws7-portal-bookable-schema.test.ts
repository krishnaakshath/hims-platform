// WS7 T7 (spec D6): providers.portal_bookable, added by a guarded block shared with Plan A WS6 T6.
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { readMigration, idempotencyProblems } from './migration-sql'

const MIGRATION = '2026-10-26-ws7-portal-bookable.sql'

describe('WS7 T7 providers.portal_bookable', () => {
  it('the migration is idempotent and only turns non-clinical doctors off when it adds the column', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(s).toMatch(/IF NOT EXISTS \([\s\S]*column_name = 'portal_bookable'[\s\S]*\) THEN[\s\S]*UPDATE providers SET portal_bookable = false[\s\S]*END IF;/)
  })

  it('a re-run keeps a later admin change (the UPDATE does not run again)', async () => {
    const db = getDb()
    const [diag] = (await db.execute(sql`SELECT p.id FROM providers p JOIN departments d ON d.id = p.department_id WHERE d.kind <> 'clinical' LIMIT 1`)).rows as { id: number }[]
    expect(diag).toBeDefined()
    await db.execute(sql`UPDATE providers SET portal_bookable = true WHERE id = ${diag.id}`)
    try {
      const body = readMigration(MIGRATION).replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')
      await db.execute(sql.raw(body))
      const [row] = (await db.execute(sql`SELECT portal_bookable FROM providers WHERE id = ${diag.id}`)).rows as { portal_bookable: boolean }[]
      expect(row.portal_bookable).toBe(true)
    } finally {
      await db.execute(sql`UPDATE providers SET portal_bookable = false WHERE id = ${diag.id}`)
    }
  })
})
