// npm run db:restore-check -- <backup.dump>
//
// The restore drill: restores a db:backup dump into an EMPTY scratch database
// (RESTORE_DATABASE_URL: a fresh Neon branch or a local database, never the
// live one), then proves it is usable: migration ledger complete for this
// checkout, billing immutability triggers present, row counts of the core
// tables printed for comparison with production. Delete the scratch
// database afterwards: it holds real patient data. See docs/OPERATIONS.md.
import dns from 'node:dns'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { describeDatabaseUrl, isPooledNeonUrl, sslFor } from '../../src/db/url'
import { readStatus } from './migrate-runner'
import { INSTALL_HELP, findPgTool, pgEnvFromUrl, refuseRestoreTarget } from './pg-tools'

dns.setDefaultResultOrder('ipv4first')

const CORE_TABLES = ['patients', 'users', 'encounters', 'invoices', 'patient_payments', 'audit_log', 'lab_reports', 'documents']
const IMMUTABILITY_TRIGGERS = ['invoices_issued_guard', 'invoice_lines_immutable', 'credit_notes_immutable', 'patient_payments_immutable', 'refunds_immutable']

async function main(): Promise<number> {
  const file = process.argv[2]
  if (!file || !fs.existsSync(file)) {
    console.error('usage: npm run db:restore-check -- <path to .dump from db:backup>')
    return 64
  }
  const target = process.env.RESTORE_DATABASE_URL
  const refusal = refuseRestoreTarget(target, process.env.DATABASE_URL)
  if (refusal) {
    console.error(refusal)
    return 1
  }
  if (isPooledNeonUrl(target)) {
    console.error('RESTORE_DATABASE_URL is a Neon pooled endpoint; use the direct one.')
    return 1
  }
  const restore = findPgTool('pg_restore')
  if (!restore) {
    console.error(INSTALL_HELP)
    return 2
  }

  const sumFile = `${file}.sha256`
  if (fs.existsSync(sumFile)) {
    const expected = fs.readFileSync(sumFile, 'utf8').split(/\s+/)[0]
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (expected !== actual) {
      console.error(`checksum mismatch for ${path.basename(file)}: the dump is corrupt or was altered`)
      return 1
    }
    console.log('checksum ok')
  } else {
    console.log('warning: no .sha256 next to the dump; integrity not verified')
  }

  const before = await readStatus({ connectionString: target })
  if (!before.databaseEmpty || before.ledgerExists) {
    console.error(`${before.target} is not empty. Restore drills need an empty database (create a new branch or database).`)
    return 1
  }

  console.log(`restoring ${path.basename(file)} into ${describeDatabaseUrl(target)} with ${restore.version}`)
  const t0 = Date.now()
  const env = pgEnvFromUrl(target!)
  const r = spawnSync(restore.bin, ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${env.PGDATABASE}`, file], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (r.status !== 0) {
    console.error(`pg_restore failed (exit ${r.status}); the drill FAILED.`)
    return 1
  }
  const restoreMs = Date.now() - t0

  const after = await readStatus({ connectionString: target })
  let failed = false
  if (after.plan.drift.length > 0) {
    console.error(`ledger: ${after.plan.drift.length} migration file(s) differ from this checkout: ${after.plan.drift.map((d) => d.name).join(', ')}`)
    failed = true
  }
  console.log(after.plan.apply.length === 0 && after.plan.adopt.length === 0
    ? 'ledger: every migration in this checkout is recorded'
    : `ledger: ${after.plan.apply.length + after.plan.adopt.length} migration(s) of this checkout are not in the backup (backup is older than the code; db:migrate would apply them)`)

  const c = new pg.Client({ connectionString: target, ssl: sslFor(target) })
  await c.connect()
  try {
    const trg = await c.query(`SELECT tgname FROM pg_trigger WHERE tgname = ANY($1)`, [IMMUTABILITY_TRIGGERS])
    const missing = IMMUTABILITY_TRIGGERS.filter((t) => !trg.rows.some((row) => row.tgname === t))
    if (missing.length > 0) {
      console.error(`missing billing immutability triggers: ${missing.join(', ')}`)
      failed = true
    } else {
      console.log('billing immutability triggers present')
    }
    console.log('row counts (compare with production):')
    for (const t of CORE_TABLES) {
      const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`])
      if (!exists.rows[0].e) {
        console.log(`  ${t.padEnd(18)} (table missing)`)
        failed = true
        continue
      }
      const n = await c.query(`SELECT count(*)::bigint AS n FROM "${t}"`)
      console.log(`  ${t.padEnd(18)} ${n.rows[0].n}`)
    }
  } finally {
    await c.end()
  }
  console.log(`restore took ${restoreMs} ms`)
  console.log(failed ? 'restore drill FAILED' : 'restore drill passed. Now delete the scratch database/branch: it holds real patient data.')
  return failed ? 1 : 0
}

main().then((code) => process.exit(code), (e) => {
  const err = e as NodeJS.ErrnoException
  console.error(`restore-check failed: ${err.name}${err.code ? ` ${err.code}` : ''}`)
  process.exit(1)
})
