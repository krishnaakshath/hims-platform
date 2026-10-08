// npm run db:migrate            apply pending migrations (baseline first on an empty database)
// npm run db:migrate -- --dry-run   show what would run, write nothing
// npm run db:migrate:status     list every file with applied/pending, flag changed files
//
// Uses DATABASE_URL (from .env.local via dotenv, or the environment, which wins).
// For Neon use the DIRECT endpoint: DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:migrate
// See docs/DEPLOYING.md and docs/OPERATIONS.md.
import dns from 'node:dns'
import { BASELINE_NAME } from '../../src/db/migrations'
import { MigrationError, readStatus, runMigrations } from './migrate-runner'

// IPv6 egress is dead on some networks this runs from; see src/db/client.ts.
dns.setDefaultResultOrder('ipv4first')

async function status(): Promise<number> {
  const s = await readStatus({ connectionString: process.env.DATABASE_URL })
  console.log(`target: ${s.target}`)
  if (!s.ledgerExists) {
    console.log(s.databaseEmpty
      ? 'empty database: `npm run db:migrate` will apply the baseline and every migration'
      : 'no migration ledger yet (schema built by drizzle-kit push): `npm run db:migrate` will adopt it')
  }
  const recorded = new Map(s.ledger.map((r) => [r.filename, r]))
  const drifted = new Set(s.plan.drift.map((d) => d.name))
  const toAdopt = new Set(s.plan.adopt.map((f) => f.name))
  const names = [BASELINE_NAME, ...s.plan.apply.map((f) => f.name), ...s.ledger.map((r) => r.filename)]
  for (const name of [...new Set(names)].sort()) {
    const r = recorded.get(name)
    const state = drifted.has(name) ? 'CHANGED' : r ? r.how : toAdopt.has(name) ? 'adopt' : 'pending'
    const when = r ? new Date(r.applied_at).toISOString() : ''
    console.log(`  ${state.padEnd(8)} ${name}${when ? `  ${when}` : ''}${r?.duration_ms ? ` (${r.duration_ms} ms)` : ''}`)
  }
  for (const n of s.plan.unknown) console.log(`  warning: ${n} is recorded but not in this checkout`)
  const pending = s.plan.apply.length + s.plan.adopt.length
  console.log(drifted.size > 0
    ? `${drifted.size} applied file(s) CHANGED since they ran: db:migrate will refuse until they are restored`
    : pending > 0 ? `${pending} pending` : 'up to date')
  return drifted.size > 0 ? 2 : 0
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2))
  for (const a of args) {
    if (!['--dry-run', '--status'].includes(a)) {
      console.error(`unknown option ${a}; use --dry-run or --status`)
      return 64
    }
  }
  if (args.has('--status')) return status()
  await runMigrations({ connectionString: process.env.DATABASE_URL, dryRun: args.has('--dry-run') })
  return 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof MigrationError) {
      console.error(`db:migrate failed (${e.code}): ${e.message}`)
    } else {
      // Connection errors: code and class only (the raw error can carry the URL).
      const err = e as NodeJS.ErrnoException
      console.error(`db:migrate failed: ${err.name ?? 'Error'}${err.code ? ` ${err.code}` : ''}: ${String(err.message ?? '').replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`)
    }
    process.exit(1)
  },
)
