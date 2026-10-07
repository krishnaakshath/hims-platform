import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'

export function readMigration(fileName: string): string {
  return readFileSync(join(process.cwd(), 'scripts', 'migrations', fileName), 'utf8')
}

/** Returns human-readable problems; empty array means the migration is idempotent and non-destructive. */
export function idempotencyProblems(sqlText: string): string[] {
  const problems: string[] = []
  const noComments = sqlText.replace(/--[^\n]*/g, '')
  const trimmed = noComments.trim()
  if (!/^BEGIN;/i.test(trimmed)) problems.push('missing leading BEGIN;')
  if (!/COMMIT;$/i.test(trimmed)) problems.push('missing trailing COMMIT;')

  const bare: Array<[string, RegExp]> = [
    ['CREATE TABLE', /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi],
    ['CREATE UNIQUE INDEX', /CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi],
    ['CREATE INDEX', /CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi],
    ['CREATE SEQUENCE', /CREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS)/gi],
    ['ADD COLUMN', /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi],
    ['CREATE EXTENSION', /CREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS)/gi],
  ]
  for (const [label, re] of bare) {
    for (const m of noComments.matchAll(re)) problems.push(`${label} without IF NOT EXISTS at ${m.index}`)
  }

  // Split into DO $$ ... END $$; blocks vs. the rest.
  const doBlocks = [...noComments.matchAll(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi)].map((m) => m[0])
  const outside = noComments.replace(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi, '')
  const unguarded = (re: RegExp, guard: RegExp, label: string) => {
    const inBlocks = doBlocks.flatMap((b) => [...b.matchAll(re)].map(() => b))
    for (const b of inBlocks) if (!guard.test(b)) problems.push(label)
    for (const m of outside.matchAll(re)) problems.push(`${label} at ${m.index}`)
  }
  unguarded(/CREATE\s+TYPE\b/gi, /duplicate_object/i, 'CREATE TYPE not guarded by a DO block catching duplicate_object')
  unguarded(/ADD\s+CONSTRAINT\b/gi, /pg_constraint/i, 'ADD CONSTRAINT not guarded by a DO block checking pg_constraint')

  for (const m of noComments.matchAll(/\bDROP\s/gi)) problems.push(`DROP is not allowed at ${m.index}`)
  return problems
}

/** Column names of `table` that never appear in the migration SQL. */
export function missingColumns(table: PgTable, sqlText: string): string[] {
  const sql = sqlText.toLowerCase()
  return getTableConfig(table).columns
    .map((c) => c.name)
    .filter((name) => !new RegExp(`\\b${name.toLowerCase()}\\b`).test(sql))
}
