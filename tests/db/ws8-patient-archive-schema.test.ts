// WS8 T13 (spec D17): patients.archived_at / archived_by_name / archive_reason and the partial
// active-UHID index, added by a re-runnable migration that mirrors src/db/schema.ts.
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { readMigration, idempotencyProblems } from './migration-sql'

const MIGRATION = '2026-10-26-ws8-patient-archive.sql'

describe('WS8 T13 patient archive columns', () => {
  it('the migration is idempotent', () => {
    expect(idempotencyProblems(readMigration(MIGRATION))).toEqual([])
  })

  it('the columns and the partial UHID index exist, and a re-run is a no-op', async () => {
    const db = getDb()
    await db.execute(sql.raw(readMigration(MIGRATION).replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')))
    const cols = (await db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'patients' AND column_name IN ('archived_at', 'archived_by_name', 'archive_reason') ORDER BY column_name`)).rows
    expect(cols).toEqual([
      { column_name: 'archive_reason', data_type: 'text' },
      { column_name: 'archived_at', data_type: 'timestamp without time zone' },
      { column_name: 'archived_by_name', data_type: 'text' },
    ])
    const [idx] = (await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'patients_active_uhid_idx'`)).rows as { indexdef: string }[]
    expect(idx.indexdef).toMatch(/\(uhid\) WHERE \(archived_at IS NULL\)/)
  })
})
