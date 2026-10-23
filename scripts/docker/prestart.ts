// Container start-up work before `next start` (scripts/docker-entrypoint.sh):
//   1. wait until the database accepts connections (the compose `postgres` service),
//   2. apply pending migrations with the checksummed runner (idempotent; a no-op
//      when the one-shot `migrate` service already ran),
//   3. seed demo data only when SEED_ON_START=true AND the database holds no
//      patients and no staff accounts, and never in production unless
//      ALLOW_PRODUCTION_SEED=1 (the seed enforces that rule again itself).
// `--wait-only` stops after step 1 (used by the migrate/seed/codes jobs).
// Log lines carry no connection string or error text that could hold one.
import dns from 'node:dns'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import { sslFor } from '../../src/db/url'

type Env = Record<string, string | undefined>

export type SeedDecision = { seed: true } | { seed: false; reason: 'not_requested' | 'production' | 'not_empty' }

/** Whether start-up should run the demo seed. Pure. */
export function decideSeedOnStart(env: Env, counts: { patients: number; users: number }): SeedDecision {
  if (env.SEED_ON_START !== 'true') return { seed: false, reason: 'not_requested' }
  if (env.NODE_ENV === 'production' && env.ALLOW_PRODUCTION_SEED !== '1') return { seed: false, reason: 'production' }
  if (counts.patients > 0 || counts.users > 0) return { seed: false, reason: 'not_empty' }
  return { seed: true }
}

/** Retries `probe` until it resolves, up to `attempts` times with `delayMs` between. Returns the attempt count. */
export async function waitFor(
  probe: () => Promise<unknown>,
  opts: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, code: string) => void },
): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      await probe()
      return attempt
    } catch (e) {
      if (attempt >= opts.attempts) throw e
      const code = (e as { code?: unknown }).code
      opts.onRetry?.(attempt, typeof code === 'string' ? code : 'error')
      await sleep(opts.delayMs)
    }
  }
}

function client(url: string): pg.Client {
  return new pg.Client({ connectionString: url, ssl: sslFor(url), connectionTimeoutMillis: 5000 })
}

async function ping(url: string): Promise<void> {
  const c = client(url)
  try {
    await c.connect()
    await c.query('select 1')
  } finally {
    await c.end().catch(() => undefined)
  }
}

async function countRows(url: string): Promise<{ patients: number; users: number }> {
  const c = client(url)
  try {
    await c.connect()
    const count = async (table: string) => {
      const exists = await c.query('select to_regclass($1) as t', [`public.${table}`])
      if (!exists.rows[0]?.t) return 0
      const r = await c.query(`select count(*)::int as n from ${table}`)
      return r.rows[0].n as number
    }
    return { patients: await count('patients'), users: await count('users') }
  } finally {
    await c.end().catch(() => undefined)
  }
}

function run(args: string[]): void {
  const tsx = path.join(process.cwd(), 'node_modules/.bin/tsx')
  const r = spawnSync(tsx, args, { stdio: 'inherit', env: process.env })
  if (r.status !== 0) throw new Error(`${args[0]} exited with ${r.status}`)
}

async function main(): Promise<void> {
  dns.setDefaultResultOrder('ipv4first')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const attempts = Number(process.env.DB_WAIT_ATTEMPTS ?? 60)
  const tries = await waitFor(() => ping(url), {
    attempts, delayMs: 2000,
    onRetry: (n, code) => console.log(`[start] waiting for the database (attempt ${n}/${attempts}, ${code})`),
  })
  console.log(`[start] database reachable (attempt ${tries})`)
  if (process.argv.includes('--wait-only')) return

  if (process.env.SKIP_MIGRATIONS === '1') {
    console.log('[start] SKIP_MIGRATIONS=1: not running migrations')
  } else {
    run(['scripts/db/migrate.ts'])
  }

  const decision = decideSeedOnStart(process.env, await countRows(url))
  if (decision.seed) {
    console.log('[start] SEED_ON_START=true and the database is empty: seeding demo data')
    run(['src/db/seed.ts'])
  } else if (decision.reason === 'production') {
    console.log('[start] SEED_ON_START=true ignored: NODE_ENV=production without ALLOW_PRODUCTION_SEED=1')
  } else if (decision.reason === 'not_empty') {
    console.log('[start] SEED_ON_START=true ignored: the database already has data')
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
if (isMain) {
  main().then(
    () => process.exit(0),
    (e) => {
      const err = e as NodeJS.ErrnoException
      console.error(`[start] failed: ${err.code ?? err.name ?? 'Error'}: ${String(err.message ?? '').replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`)
      process.exit(1)
    },
  )
}
