import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { abhaLinkOverrides } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

// WS12 T5: abha_link_overrides (spec §4) -- the migration matches src/db/schema.ts and the
// table is append-only.
const M = '2026-10-24-ws12-abha-link-overrides.sql'

describe('WS12 abha_link_overrides migration (static)', () => {
  it('is idempotent, declares every column and names every constraint and index', () => {
    const s = readMigration(M)
    expect(idempotencyProblems(s)).toEqual([])
    expect(missingColumns(abhaLinkOverrides, s)).toEqual([])
    const c = getTableConfig(abhaLinkOverrides)
    const names = [...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!)]
    expect(names.length).toBe(8)
    for (const n of names) { expect(n.length, n).toBeLessThanOrEqual(63); expect(s, n).toContain(n) }
    for (const fk of c.foreignKeys) expect(fk.onDelete ?? 'no action').toBe('no action')
    expect(s).toContain("current_setting('hims.allow_document_purge', true) = 'on'")
    expect(s).toContain('CREATE TRIGGER ws12_abha_link_overrides_append_only BEFORE UPDATE OR DELETE ON abha_link_overrides')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('WS12 abha_link_overrides (DB)', () => {
  it('the live table has the schema.ts columns, constraints and the append-only trigger', async () => {
    const cols = await getDb().execute<{ column_name: string; is_nullable: string }>(sql`
      select column_name, is_nullable from information_schema.columns where table_name = 'abha_link_overrides' order by column_name`)
    const c = getTableConfig(abhaLinkOverrides)
    expect(cols.rows.map((r) => `${r.column_name}:${r.is_nullable}`)).toEqual(
      c.columns.map((col) => `${col.name}:${col.notNull ? 'NO' : 'YES'}`).sort())
    const cons = await getDb().execute<{ conname: string }>(sql`select conname from pg_constraint where conrelid = 'abha_link_overrides'::regclass and contype in ('c', 'f')`)
    expect(cons.rows.map((r) => r.conname).sort()).toEqual([...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name)].sort())
    const trg = await getDb().execute<{ tgname: string }>(sql`select tgname from pg_trigger where tgrelid = 'abha_link_overrides'::regclass and not tgisinternal`)
    expect(trg.rows.map((r) => r.tgname)).toEqual(['ws12_abha_link_overrides_append_only'])
  })
})
