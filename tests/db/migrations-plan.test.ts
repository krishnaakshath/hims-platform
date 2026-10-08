// Pure logic of the migration runner (scripts/db/migrate.ts): file ordering,
// checksum drift, ledger adoption, transaction handling and the status the
// health route reports. No database here; tests/db/migrate-runner.test.ts
// drives the real runner against a scratch Postgres.
import { describe, it, expect } from 'vitest'
import {
  BASELINE_NAME,
  checksumOf,
  migrationStatus,
  orderMigrationNames,
  planMigrations,
  transactionModeOf,
  type MigrationFile,
} from '@/db/migrations'

const file = (name: string, sql = `SELECT '${name}';`): MigrationFile => ({ name, sql, checksum: checksumOf(sql) })
const baseline = file(BASELINE_NAME, 'CREATE TABLE patients (id serial);')

describe('orderMigrationNames', () => {
  it('keeps only .sql files and sorts them by date-prefixed name', () => {
    expect(orderMigrationNames([
      '2026-10-08-sp5-lab-home-collection.sql',
      'README.md',
      '2026-10-04-assignment-notifications.sql',
      '2026-10-08-sp5-lab-enum-values.sql',
      '2026-10-07-sp6-a-coder-role.sql',
      '2026-10-07-sp6-b-clinical-coding.sql',
    ])).toEqual([
      '2026-10-04-assignment-notifications.sql',
      '2026-10-07-sp6-a-coder-role.sql',
      '2026-10-07-sp6-b-clinical-coding.sql',
      '2026-10-08-sp5-lab-enum-values.sql',
      '2026-10-08-sp5-lab-home-collection.sql',
    ])
  })

  it('sorts by code point, not locale (a-z suffixes stay stable)', () => {
    expect(orderMigrationNames(['2026-10-08-sp4-b.sql', '2026-10-08-sp4-a.sql', '2026-10-08-SP4-c.sql']))
      .toEqual(['2026-10-08-SP4-c.sql', '2026-10-08-sp4-a.sql', '2026-10-08-sp4-b.sql'])
  })

  it('rejects a file that does not start with a YYYY-MM-DD date', () => {
    expect(() => orderMigrationNames(['fix-things.sql'])).toThrow(/fix-things\.sql/)
  })
})

describe('checksumOf', () => {
  it('is a sha256 hex digest', () => {
    expect(checksumOf('SELECT 1;')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores CRLF vs LF so a Windows checkout does not look like drift', () => {
    expect(checksumOf('SELECT 1;\r\nSELECT 2;\r\n')).toBe(checksumOf('SELECT 1;\nSELECT 2;\n'))
  })

  it('changes when the content changes', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'))
  })
})

describe('planMigrations', () => {
  const a = file('2026-10-04-a.sql')
  const b = file('2026-10-07-b.sql')

  it('fresh: an empty database gets the baseline and then every migration, in order', () => {
    const plan = planMigrations({ baseline, files: [b, a], ledger: [], databaseEmpty: true })
    expect(plan.mode).toBe('fresh')
    expect(plan.apply.map((f) => f.name)).toEqual([BASELINE_NAME, a.name, b.name])
    expect(plan.adopt).toEqual([])
    expect(plan.drift).toEqual([])
  })

  it('adopt: a populated database with no ledger records the baseline without running it and re-runs every migration', () => {
    const plan = planMigrations({ baseline, files: [a, b], ledger: [], databaseEmpty: false })
    expect(plan.mode).toBe('adopt')
    expect(plan.adopt.map((f) => f.name)).toEqual([BASELINE_NAME])
    expect(plan.apply.map((f) => f.name)).toEqual([a.name, b.name])
  })

  it('incremental: only files missing from the ledger are applied', () => {
    const ledger = [
      { filename: BASELINE_NAME, checksum: baseline.checksum },
      { filename: a.name, checksum: a.checksum },
    ]
    const plan = planMigrations({ baseline, files: [a, b], ledger, databaseEmpty: false })
    expect(plan.mode).toBe('incremental')
    expect(plan.apply.map((f) => f.name)).toEqual([b.name])
    expect(plan.adopt).toEqual([])
  })

  it('up to date: nothing to apply on a second run', () => {
    const ledger = [baseline, a, b].map((f) => ({ filename: f.name, checksum: f.checksum }))
    const plan = planMigrations({ baseline, files: [a, b], ledger, databaseEmpty: false })
    expect(plan.apply).toEqual([])
    expect(plan.adopt).toEqual([])
    expect(plan.drift).toEqual([])
  })

  it('reports drift when an applied file was edited afterwards', () => {
    const ledger = [
      { filename: BASELINE_NAME, checksum: baseline.checksum },
      { filename: a.name, checksum: checksumOf('SELECT 0; -- the original') },
    ]
    const plan = planMigrations({ baseline, files: [a, b], ledger, databaseEmpty: false })
    expect(plan.drift).toEqual([{ name: a.name, recorded: checksumOf('SELECT 0; -- the original'), current: a.checksum }])
  })

  it('reports drift on the baseline too', () => {
    const ledger = [{ filename: BASELINE_NAME, checksum: checksumOf('something else') }]
    const plan = planMigrations({ baseline, files: [], ledger, databaseEmpty: false })
    expect(plan.drift.map((d) => d.name)).toEqual([BASELINE_NAME])
  })

  it('lists ledger rows whose file no longer exists (older code against a newer database)', () => {
    const ledger = [
      { filename: BASELINE_NAME, checksum: baseline.checksum },
      { filename: '2026-11-01-from-the-future.sql', checksum: checksumOf('x') },
    ]
    const plan = planMigrations({ baseline, files: [a], ledger, databaseEmpty: false })
    expect(plan.unknown).toEqual(['2026-11-01-from-the-future.sql'])
  })

  it('a ledger with rows but no baseline row (interrupted adoption) is still adopt, keeping what is recorded', () => {
    const ledger = [{ filename: a.name, checksum: a.checksum }]
    const plan = planMigrations({ baseline, files: [a, b], ledger, databaseEmpty: false })
    expect(plan.mode).toBe('adopt')
    expect(plan.adopt.map((f) => f.name)).toEqual([BASELINE_NAME])
    expect(plan.apply.map((f) => f.name)).toEqual([b.name])
  })
})

describe('transactionModeOf', () => {
  it('wraps a plain file in a transaction', () => {
    expect(transactionModeOf('ALTER TABLE x ADD COLUMN IF NOT EXISTS y int;')).toBe('wrap')
  })

  it('leaves a file that has its own BEGIN; ... COMMIT; to manage itself', () => {
    expect(transactionModeOf('-- header\nBEGIN;\nALTER TYPE role ADD VALUE IF NOT EXISTS \'coder\';\nCOMMIT;\n')).toBe('self')
  })

  it('does not mistake a plpgsql BEGIN block for a transaction', () => {
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;`
    expect(transactionModeOf(sql)).toBe('wrap')
  })

  it('ignores BEGIN; inside a comment', () => {
    expect(transactionModeOf('-- run inside BEGIN; ... COMMIT; by hand\nSELECT 1;')).toBe('wrap')
  })

  it('runs CONCURRENTLY index builds outside any transaction', () => {
    expect(transactionModeOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);')).toBe('none')
  })

  it('honours an explicit no-transaction directive', () => {
    expect(transactionModeOf('-- migrate:no-transaction\nVACUUM t;')).toBe('none')
  })
})

describe('migrationStatus', () => {
  it('is up_to_date when every file is in the ledger', () => {
    expect(migrationStatus([BASELINE_NAME, 'a.sql', 'b.sql'], ['a.sql', 'b.sql'])).toBe('up_to_date')
  })

  it('is pending when a file is missing from the ledger', () => {
    expect(migrationStatus([BASELINE_NAME, 'a.sql'], ['a.sql', 'b.sql'])).toBe('pending')
  })

  it('is pending when the baseline itself is missing (database never migrated)', () => {
    expect(migrationStatus([], ['a.sql'])).toBe('pending')
  })

  it('is unknown when the ledger or the file list cannot be read', () => {
    expect(migrationStatus(null, ['a.sql'])).toBe('unknown')
    expect(migrationStatus([BASELINE_NAME], null)).toBe('unknown')
  })
})

describe('scripts/db/baseline.sql', () => {
  // Every migrated database records this checksum; changing the file makes
  // db:migrate refuse to run everywhere. Schema changes go in a new file in
  // scripts/migrations/, never in the baseline.
  it('is frozen', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sql = fs.readFileSync(path.resolve(__dirname, '../../scripts/db/baseline.sql'), 'utf8')
    expect(checksumOf(sql)).toBe('a9bb604bc7a3ee4c92cfd098151b9fcfc8e3fcde808d2761261136d606cb7af3')
  })

  it('every file in scripts/migrations has a dated name the runner accepts', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const names = fs.readdirSync(path.resolve(__dirname, '../../scripts/migrations'))
    expect(() => orderMigrationNames(names)).not.toThrow()
    expect(orderMigrationNames(names).length).toBe(names.filter((n) => n.endsWith('.sql')).length)
  })
})
