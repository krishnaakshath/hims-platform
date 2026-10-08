// The migration runner behind `npm run db:migrate` (CLI: scripts/db/migrate.ts).
// Planning logic lives in src/db/migrations.ts; this file does the I/O.
//
// One database, one ledger (`schema_migrations`), one advisory lock:
//   empty database        -> scripts/db/baseline.sql, then every migration
//   no ledger, has tables -> "adopt": record the baseline as already present,
//                            re-run every (idempotent) migration and record it
//   ledger present        -> run only the files not yet recorded
// A recorded file whose checksum changed stops everything before any write.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import {
  BASELINE_NAME,
  LEDGER_TABLE,
  MIGRATION_LOCK_KEY,
  checksumOf,
  orderMigrationNames,
  planMigrations,
  transactionModeOf,
  type LedgerRow,
  type MigrationFile,
  type MigrationPlan,
} from '../../src/db/migrations'
import { describeDatabaseUrl, isPooledNeonUrl, sslFor } from '../../src/db/url'

const ROOT = path.resolve(__dirname, '../..')
export const DEFAULT_MIGRATIONS_DIR = path.join(ROOT, 'scripts/migrations')
export const DEFAULT_BASELINE_PATH = path.join(ROOT, 'scripts/db/baseline.sql')

export type MigrationErrorCode = 'config' | 'pooler' | 'lock' | 'drift' | 'not_hims' | 'failed'
export class MigrationError extends Error {
  constructor(public code: MigrationErrorCode, message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

export type RunOptions = {
  connectionString: string | undefined
  migrationsDir?: string
  baselinePath?: string
  dryRun?: boolean
  lockTimeoutMs?: number
  log?: (line: string) => void
}

export type RunResult = {
  mode: MigrationPlan['mode']
  applied: string[] // run (or, with dryRun, that would run)
  adopted: string[]
  unknown: string[]
}

export type StatusResult = {
  target: string
  ledgerExists: boolean
  databaseEmpty: boolean
  plan: MigrationPlan
  ledger: (LedgerRow & { applied_at: Date; duration_ms: number; how: string })[]
}

function readFile(dir: string, name: string): MigrationFile {
  const sql = fs.readFileSync(path.join(dir, name), 'utf8')
  return { name, sql, checksum: checksumOf(sql) }
}

export function loadMigrationFiles(dir = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  return orderMigrationNames(fs.readdirSync(dir)).map((n) => readFile(dir, n))
}

export function loadBaseline(file = DEFAULT_BASELINE_PATH): MigrationFile {
  const sql = fs.readFileSync(file, 'utf8')
  return { name: BASELINE_NAME, sql, checksum: checksumOf(sql) }
}

function connect(connectionString: string | undefined): pg.Client {
  if (!connectionString) {
    throw new MigrationError('config', 'DATABASE_URL is not set. Set it to the target database (for Neon, the direct, non-pooled URL).')
  }
  if (isPooledNeonUrl(connectionString)) {
    throw new MigrationError('pooler',
      'DATABASE_URL points at the Neon pooled endpoint ("-pooler" host). Migrations need a direct connection ' +
      '(advisory lock, per-file transactions): use DATABASE_URL_UNPOOLED, e.g. DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:migrate')
  }
  return new pg.Client({ connectionString, ssl: sslFor(connectionString), connectionTimeoutMillis: 15_000 })
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL,
  how         text NOT NULL CHECK (how IN ('applied', 'adopted'))
)`

async function ledgerExists(c: pg.Client): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${LEDGER_TABLE}`])
  return r.rows[0].e
}

async function readLedger(c: pg.Client): Promise<StatusResult['ledger']> {
  if (!(await ledgerExists(c))) return []
  const r = await c.query(`SELECT filename, checksum, applied_at, duration_ms, how FROM ${LEDGER_TABLE} ORDER BY filename`)
  return r.rows
}

// "Empty" = nothing of ours in the public schema: no tables, views,
// sequences or types other than the ledger itself.
async function isDatabaseEmpty(c: pg.Client): Promise<boolean> {
  const r = await c.query(
    `SELECT
       (SELECT count(*) FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = 'public' AND cl.relkind IN ('r','p','v','m','S','f')
            AND cl.relname NOT IN ($1, $2)) +
       (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typtype IN ('e','d','c')
            AND NOT EXISTS (SELECT 1 FROM pg_class cl WHERE cl.reltype = t.oid)) AS n`,
    [LEDGER_TABLE, `${LEDGER_TABLE}_pkey`],
  )
  return Number(r.rows[0].n) === 0
}

async function acquireLock(c: pg.Client, timeoutMs: number, log: (l: string) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let announced = false
  for (;;) {
    const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_KEY])
    if (r.rows[0].ok) return
    if (Date.now() >= deadline) {
      throw new MigrationError('lock', `Another migration is running against this database (advisory lock ${MIGRATION_LOCK_KEY} is held). Wait for it to finish and run again.`)
    }
    if (!announced) {
      log('waiting for another migration run to finish ...')
      announced = true
    }
    await new Promise((res) => setTimeout(res, Math.min(500, Math.max(50, deadline - Date.now()))))
  }
}

function pgErrorText(e: unknown): string {
  const err = e as { code?: string; message?: string; position?: string; where?: string }
  return [err.code ? `[${err.code}]` : '', err.message ?? String(e), err.where ? `(${err.where.split('\n')[0]})` : '']
    .filter(Boolean).join(' ')
}

async function record(c: pg.Client, f: MigrationFile, ms: number, how: 'applied' | 'adopted') {
  await c.query(
    `INSERT INTO ${LEDGER_TABLE} (filename, checksum, duration_ms, how) VALUES ($1, $2, $3, $4)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now(), duration_ms = EXCLUDED.duration_ms, how = EXCLUDED.how`,
    [f.name, f.checksum, ms, how],
  )
}

async function applyOne(c: pg.Client, f: MigrationFile): Promise<number> {
  const mode = transactionModeOf(f.sql)
  const t0 = Date.now()
  try {
    if (mode === 'wrap') {
      await c.query('BEGIN')
      await c.query(f.sql)
      await record(c, f, Date.now() - t0, 'applied')
      await c.query('COMMIT')
    } else if (mode === 'none') {
      // A multi-statement query string is itself an implicit transaction, so
      // statements that refuse transactions (CREATE INDEX CONCURRENTLY) go
      // one at a time. Such files must be plain statements, one per line
      // ending in ';' (no dollar-quoted bodies).
      for (const stmt of f.sql.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.replace(/--[^\n]*/g, '').trim() !== '')) {
        await c.query(stmt)
      }
      await record(c, f, Date.now() - t0, 'applied')
    } else {
      // 'self' files commit their own transaction.
      await c.query(f.sql)
      await record(c, f, Date.now() - t0, 'applied')
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw new MigrationError('failed', `Migration ${f.name} failed and was rolled back: ${pgErrorText(e)}`)
  }
  return Date.now() - t0
}

function reportDrift(plan: MigrationPlan, log: (l: string) => void) {
  for (const d of plan.drift) {
    log(`CHANGED after it was applied: ${d.name}\n    recorded ${d.recorded}\n    current  ${d.current}`)
  }
}

export async function readStatus(opts: RunOptions): Promise<StatusResult> {
  const c = connect(opts.connectionString)
  await c.connect()
  try {
    const ledger = await readLedger(c)
    const exists = await ledgerExists(c)
    const databaseEmpty = await isDatabaseEmpty(c)
    const plan = planMigrations({
      baseline: loadBaseline(opts.baselinePath),
      files: loadMigrationFiles(opts.migrationsDir),
      ledger,
      databaseEmpty,
    })
    return { target: describeDatabaseUrl(opts.connectionString), ledgerExists: exists, databaseEmpty, plan, ledger }
  } finally {
    await c.end().catch(() => {})
  }
}

export async function runMigrations(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const baseline = loadBaseline(opts.baselinePath)
  const files = loadMigrationFiles(opts.migrationsDir)
  const c = connect(opts.connectionString)
  // An idle-connection reset must not crash the process mid-run.
  c.on('error', (e) => log(`[db] connection error: ${(e as NodeJS.ErrnoException).code ?? e.name}`))
  await c.connect()
  let locked = false
  try {
    log(`target: ${describeDatabaseUrl(opts.connectionString)}${opts.dryRun ? ' (dry run, nothing is written)' : ''}`)
    if (!opts.dryRun) {
      await acquireLock(c, opts.lockTimeoutMs ?? 120_000, log)
      locked = true
    }
    const databaseEmpty = await isDatabaseEmpty(c)
    const ledger = await readLedger(c)
    const plan = planMigrations({ baseline, files, ledger, databaseEmpty })

    if (plan.drift.length > 0) {
      reportDrift(plan, log)
      throw new MigrationError('drift',
        `Refusing to migrate: ${plan.drift.length} applied migration file(s) changed afterwards (${plan.drift.map((d) => d.name).join(', ')}). ` +
        'Restore the original file(s) and put the change in a new migration.')
    }
    for (const n of plan.unknown) {
      log(`warning: ${n} is recorded in the database but not present in this checkout (is this an older version of the code?)`)
    }
    if (plan.mode === 'adopt') {
      const r = await c.query(`SELECT to_regclass('public.patients') IS NOT NULL AND to_regclass('public.users') IS NOT NULL AS ok`)
      if (!r.rows[0].ok) {
        throw new MigrationError('not_hims',
          'The database is not empty but has no HIMS tables (patients, users) and no migration ledger. Refusing to touch it; point DATABASE_URL at an empty database or an existing HIMS database.')
      }
    }

    log(`mode: ${plan.mode}; ${plan.adopt.length} to record as already present, ${plan.apply.length} to apply`)
    const result: RunResult = { mode: plan.mode, applied: plan.apply.map((f) => f.name), adopted: plan.adopt.map((f) => f.name), unknown: plan.unknown }
    if (opts.dryRun) {
      for (const f of plan.adopt) log(`  would record ${f.name} (already present)`)
      for (const f of plan.apply) log(`  would apply  ${f.name} [${transactionModeOf(f.sql)}]`)
      return result
    }

    await c.query(LEDGER_DDL)
    for (const f of plan.adopt) {
      await record(c, f, 0, 'adopted')
      log(`  recorded ${f.name} (already present)`)
    }
    for (const f of plan.apply) {
      const ms = await applyOne(c, f)
      log(`  applied  ${f.name} (${ms} ms)`)
    }
    log(plan.apply.length === 0 && plan.adopt.length === 0 ? 'database is up to date' : 'done')
    return result
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
    await c.end().catch(() => {})
  }
}
