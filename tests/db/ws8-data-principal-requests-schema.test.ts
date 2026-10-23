// WS8 T14 (spec D18): data_principal_requests, added by a re-runnable migration that mirrors
// src/db/schema.ts.
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { dataPrincipalRequests } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-26-ws8-data-principal-requests.sql'

describe('WS8 T14 data_principal_requests table', () => {
  it('the migration is idempotent and covers every schema column', () => {
    const text = readMigration(MIGRATION)
    expect(idempotencyProblems(text)).toEqual([])
    expect(missingColumns(dataPrincipalRequests, text)).toEqual([])
  })

  it('the table exists with its checks, and a re-run is a no-op', async () => {
    const db = getDb()
    await db.execute(sql.raw(readMigration(MIGRATION).replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')))
    const checks = (await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid = 'data_principal_requests'::regclass AND contype = 'c' ORDER BY conname`)).rows.map((r) => (r as { conname: string }).conname)
    expect(checks).toEqual([
      'data_principal_requests_checklist_object',
      'data_principal_requests_closed',
      'data_principal_requests_due_after_receipt',
      'data_principal_requests_kind_valid',
      'data_principal_requests_reference_format',
      'data_principal_requests_status_valid',
      'data_principal_requests_via_valid',
    ])
  })
})
