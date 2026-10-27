// WS7 T10 (spec D16): broadcasts.filters, template_key and the sent/skipped/failed counts.
import { describe, it, expect } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { broadcasts } from '@/db/schema'
import { readMigration, idempotencyProblems } from './migration-sql'

describe('WS7 T10 broadcast columns', () => {
  it('the migration is idempotent and adds every schema column', () => {
    const s = readMigration('2026-10-26-ws7-broadcast-filters.sql')
    expect(idempotencyProblems(s)).toEqual([])
    const cols = new Set(getTableConfig(broadcasts).columns.map((c) => c.name))
    for (const n of ['filters', 'template_key', 'sent_count', 'skipped_count', 'failed_count']) {
      expect(cols.has(n), n).toBe(true)
      expect(s).toContain(`ADD COLUMN IF NOT EXISTS ${n}`)
    }
  })
})
