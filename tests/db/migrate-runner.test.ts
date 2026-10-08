// @vitest-environment node
// Integration test for the migration runner: builds a brand-new scratch
// database through scripts/db/migrate-runner.ts and checks the result, then
// re-runs it (no-op), adopts a ledger-less database, detects drift and
// respects the advisory lock. Runs only against a LOCAL Postgres (it creates
// and drops a database); skipped when DATABASE_URL is missing or hosted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { isLocalDatabaseUrl } from '@/db/url'
import { BASELINE_NAME, LEDGER_TABLE, MIGRATION_LOCK_KEY } from '@/db/migrations'
import { runMigrations, MigrationError } from '../../scripts/db/migrate-runner'

const baseUrl = process.env.DATABASE_URL
const enabled = isLocalDatabaseUrl(baseUrl)
const scratchName = `hims_migrate_it_${process.pid}`

function urlFor(db: string): string {
  const u = new URL(baseUrl!)
  u.pathname = `/${db}`
  return u.toString()
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor('postgres') })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function onScratch<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(scratchName) })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

const quiet = () => {}

describe.skipIf(!enabled)('db:migrate against a scratch database', () => {
  beforeAll(async () => {
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${scratchName}`)
      await c.query(`CREATE DATABASE ${scratchName}`)
    })
  })

  afterAll(async () => {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`))
  })

  it('builds an empty database: baseline, then every migration, all recorded', { timeout: 120_000 }, async () => {
    const result = await runMigrations({ connectionString: urlFor(scratchName), log: quiet })
    expect(result.mode).toBe('fresh')
    expect(result.applied[0]).toBe(BASELINE_NAME)
    expect(result.applied.length).toBeGreaterThan(10)

    await onScratch(async (c) => {
      const tables = await c.query(`SELECT to_regclass('public.patients') AS p, to_regclass('public.invoices') AS i,
        to_regclass('public.audit_log') AS a, to_regclass('public.lab_requisitions') AS l`)
      expect(Object.values(tables.rows[0]).every((v) => v !== null)).toBe(true)

      // Migration-only objects that schema.ts cannot express.
      const excl = await c.query(`SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_no_overlap'`)
      expect(excl.rowCount).toBe(1)
      const trg = await c.query(`SELECT tgname FROM pg_trigger WHERE tgname IN
        ('invoices_issued_guard','invoice_lines_immutable','credit_notes_immutable','patient_payments_immutable','refunds_immutable')`)
      expect(trg.rowCount).toBe(5)
      const idx = await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'codes_display_trgm_idx'`)
      expect(idx.rowCount).toBe(1)
      const roles = await c.query(`SELECT array_agg(e.enumlabel::text) AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'role'`)
      expect(roles.rows[0].v).toEqual(expect.arrayContaining(['admin', 'coder', 'collector']))

      const ledger = await c.query(`SELECT filename, checksum, duration_ms, how FROM ${LEDGER_TABLE} ORDER BY filename`)
      expect(ledger.rowCount).toBe(result.applied.length)
      expect(ledger.rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum) && r.how === 'applied' && r.duration_ms >= 0)).toBe(true)
    })
  })

  it('a second run is a no-op', { timeout: 60_000 }, async () => {
    const result = await runMigrations({ connectionString: urlFor(scratchName), log: quiet })
    expect(result.mode).toBe('incremental')
    expect(result.applied).toEqual([])
    expect(result.adopted).toEqual([])
  })

  it('--dry-run reports without writing', { timeout: 60_000 }, async () => {
    await onScratch((c) => c.query(`DELETE FROM ${LEDGER_TABLE} WHERE filename <> $1`, [BASELINE_NAME]))
    const before = await onScratch((c) => c.query(`SELECT count(*)::int AS n FROM ${LEDGER_TABLE}`))
    const result = await runMigrations({ connectionString: urlFor(scratchName), dryRun: true, log: quiet })
    expect(result.applied.length).toBeGreaterThan(10)
    const after = await onScratch((c) => c.query(`SELECT count(*)::int AS n FROM ${LEDGER_TABLE}`))
    expect(after.rows[0].n).toBe(before.rows[0].n)
    // Every migration is idempotent: re-applying them all over the full schema succeeds.
    const real = await runMigrations({ connectionString: urlFor(scratchName), log: quiet })
    expect(real.applied).toEqual(result.applied)
  })

  it('adopts a database that has the schema but no ledger (built by drizzle-kit push)', { timeout: 120_000 }, async () => {
    await onScratch((c) => c.query(`DROP TABLE ${LEDGER_TABLE}`))
    const result = await runMigrations({ connectionString: urlFor(scratchName), log: quiet })
    expect(result.mode).toBe('adopt')
    expect(result.adopted).toEqual([BASELINE_NAME])
    expect(result.applied.length).toBeGreaterThan(10)
    const how = await onScratch((c) => c.query(`SELECT how FROM ${LEDGER_TABLE} WHERE filename = $1`, [BASELINE_NAME]))
    expect(how.rows[0].how).toBe('adopted')
    const again = await runMigrations({ connectionString: urlFor(scratchName), log: quiet })
    expect(again.applied).toEqual([])
  })

  it('refuses to run when an applied file changed, naming the file', { timeout: 60_000 }, async () => {
    const name = await onScratch(async (c) => {
      const r = await c.query(`SELECT filename FROM ${LEDGER_TABLE} WHERE filename <> $1 ORDER BY filename LIMIT 1`, [BASELINE_NAME])
      await c.query(`UPDATE ${LEDGER_TABLE} SET checksum = repeat('0', 64) WHERE filename = $1`, [r.rows[0].filename])
      return r.rows[0].filename as string
    })
    const lines: string[] = []
    await expect(runMigrations({ connectionString: urlFor(scratchName), log: (l) => lines.push(l) }))
      .rejects.toMatchObject({ code: 'drift' })
    expect(lines.join('\n')).toContain(name)
    // put it back for the next test
    await onScratch((c) => c.query(`DELETE FROM ${LEDGER_TABLE} WHERE filename = $1`, [name]))
    await runMigrations({ connectionString: urlFor(scratchName), log: quiet })
  })

  it('waits for the advisory lock and gives up with a clear error while another run holds it', { timeout: 60_000 }, async () => {
    const holder = new pg.Client({ connectionString: urlFor(scratchName) })
    await holder.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
      const err = await runMigrations({ connectionString: urlFor(scratchName), lockTimeoutMs: 600, log: quiet }).catch((e) => e)
      expect(err).toBeInstanceOf(MigrationError)
      expect(err.code).toBe('lock')
    } finally {
      await holder.end()
    }
  })

  it('stops at a failing migration, rolls it back, and does not record it', { timeout: 60_000 }, async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hims-mig-'))
    const real = path.resolve(__dirname, '../../scripts/migrations')
    for (const f of fs.readdirSync(real)) fs.copyFileSync(path.join(real, f), path.join(dir, f))
    fs.writeFileSync(path.join(dir, '2099-01-01-broken.sql'), 'CREATE TABLE it_half_done (id int);\nSELECT * FROM no_such_table;\n')
    const err = await runMigrations({ connectionString: urlFor(scratchName), migrationsDir: dir, log: quiet }).catch((e) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect(err.code).toBe('failed')
    expect(err.message).toContain('2099-01-01-broken.sql')
    const state = await onScratch((c) => c.query(`SELECT to_regclass('public.it_half_done') AS t,
      (SELECT count(*)::int FROM ${LEDGER_TABLE} WHERE filename = '2099-01-01-broken.sql') AS n`))
    expect(state.rows[0]).toEqual({ t: null, n: 0 })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
