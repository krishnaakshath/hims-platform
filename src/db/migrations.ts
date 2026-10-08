import { createHash } from 'node:crypto'

// Pure logic of the migration runner (scripts/db/migrate.ts) and of the
// migrations check in GET /api/health. No database access here.
//
// The schema is: scripts/db/baseline.sql (the full schema as of the day the
// ledger was introduced, exported from src/db/schema.ts), then every
// scripts/migrations/*.sql in file-name order. Each migration file is
// idempotent, so it can run on a database where its change already exists.
// `schema_migrations` records what has run and the checksum it had.

export const BASELINE_NAME = '0000-baseline.sql'
export const LEDGER_TABLE = 'schema_migrations'
// Arbitrary but fixed: every deploy that migrates takes this session-level
// advisory lock, so two concurrent `db:migrate` runs cannot interleave.
export const MIGRATION_LOCK_KEY = 7_242_011_001

export type MigrationFile = { name: string; sql: string; checksum: string }
export type LedgerRow = { filename: string; checksum: string }
export type Drift = { name: string; recorded: string; current: string }
export type MigrationPlan = {
  // fresh: empty database. adopt: a database built before the ledger existed
  // (drizzle-kit push plus hand-applied SQL). incremental: ledger present.
  mode: 'fresh' | 'adopt' | 'incremental'
  apply: MigrationFile[] // run, in this order, then record
  adopt: MigrationFile[] // record only (already present in the database)
  drift: Drift[] // applied files whose content changed afterwards: refuse to run
  unknown: string[] // ledger rows with no file in this checkout
}
export type TransactionMode = 'wrap' | 'self' | 'none'
export type MigrationStatus = 'up_to_date' | 'pending' | 'unknown'

const NAME_RE = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+\.sql$/

/** The .sql names in apply order: plain code-point order of the date-prefixed name. */
export function orderMigrationNames(names: string[]): string[] {
  const sql = names.filter((n) => n.endsWith('.sql'))
  const bad = sql.filter((n) => !NAME_RE.test(n))
  if (bad.length > 0) {
    throw new Error(`Migration file names must start with a YYYY-MM-DD date: ${bad.join(', ')}`)
  }
  return [...sql].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
}

/** sha256 of the file with line endings normalised (CRLF checkouts are not drift). */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

export function planMigrations(input: {
  baseline: MigrationFile
  files: MigrationFile[]
  ledger: LedgerRow[]
  databaseEmpty: boolean
}): MigrationPlan {
  const { baseline, ledger, databaseEmpty } = input
  const files = orderMigrationNames(input.files.map((f) => f.name)).map((n) => input.files.find((f) => f.name === n)!)
  const recorded = new Map(ledger.map((r) => [r.filename, r.checksum]))

  const drift: Drift[] = []
  for (const f of [baseline, ...files]) {
    const sum = recorded.get(f.name)
    if (sum !== undefined && sum !== f.checksum) drift.push({ name: f.name, recorded: sum, current: f.checksum })
  }
  const known = new Set([baseline.name, ...files.map((f) => f.name)])
  const unknown = ledger.map((r) => r.filename).filter((n) => !known.has(n))
  const notRecorded = files.filter((f) => !recorded.has(f.name))

  if (recorded.has(baseline.name)) {
    return { mode: 'incremental', apply: notRecorded, adopt: [], drift, unknown }
  }
  if (databaseEmpty && ledger.length === 0) {
    return { mode: 'fresh', apply: [baseline, ...files], adopt: [], drift, unknown }
  }
  return { mode: 'adopt', apply: notRecorded, adopt: [baseline], drift, unknown }
}

// Removes -- line comments and /* */ block comments (good enough for
// detection; dollar-quoted bodies are left alone apart from their comments).
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * How the runner executes a file:
 * - self: the file has its own top-level `BEGIN; ... COMMIT;` (every file
 *   in scripts/migrations today). Run as written; Postgres forbids nesting.
 *   The ledger row is written right after it commits; a crash in between
 *   only means the (idempotent) file runs again next time.
 * - none: statements that cannot run in a transaction block (CREATE/DROP
 *   INDEX CONCURRENTLY, VACUUM) or an explicit `-- migrate:no-transaction`.
 * - wrap: anything else, run in BEGIN/COMMIT together with its ledger row.
 *
 * `ALTER TYPE ... ADD VALUE` is allowed inside a transaction on PG 12+; the
 * new value just cannot be used until that transaction commits. The existing
 * files keep ADD VALUE in their own file for exactly that reason.
 */
export function transactionModeOf(sql: string): TransactionMode {
  if (/^\s*--\s*migrate:no-transaction\b/m.test(sql)) return 'none'
  const code = stripComments(sql)
  if (/^\s*(BEGIN|START\s+TRANSACTION)\s*;/im.test(code)) return 'self'
  if (/\bCONCURRENTLY\b/i.test(code) || /^\s*VACUUM\b/im.test(code)) return 'none'
  return 'wrap'
}

/** What GET /api/health reports: null means that side could not be read. */
export function migrationStatus(applied: string[] | null, files: string[] | null): MigrationStatus {
  if (applied === null || files === null) return 'unknown'
  const done = new Set(applied)
  if (!done.has(BASELINE_NAME)) return 'pending'
  return files.every((f) => done.has(f)) ? 'up_to_date' : 'pending'
}
