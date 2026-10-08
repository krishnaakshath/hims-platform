import fs from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { LEDGER_TABLE, migrationStatus, orderMigrationNames, type MigrationStatus } from '@/db/migrations'
import { getRedis, isCacheConfigured } from '@/lib/cache'
import { isBlobConfigured } from '@/lib/service-config'

// Backing-service checks behind the public GET /api/health and
// GET /api/health/ready. The report holds fixed status words only: never an
// env var name or value, never error text (it can carry a connection string
// or user name). Operators get detail from `npm run db:migrate:status` and
// the server log, not from this endpoint.

export type HealthChecks = {
  database: 'ok' | 'fail'
  redis: 'ok' | 'fail' | 'not_configured'
  migrations: MigrationStatus
  secrets: 'ok' | 'missing'
  // Configured or not only: no network round trip to the store.
  blob: 'ok' | 'not_configured'
}
export type HealthReport = { status: 'ok' | 'degraded' | 'down'; checks: HealthChecks }

export type HealthDeps = {
  pingDatabase: () => Promise<unknown>
  redisConfigured: () => boolean
  blobConfigured: () => boolean
  pingRedis: () => Promise<unknown>
  appliedMigrations: () => Promise<string[]>
  migrationFiles: () => string[]
  env: Record<string, string | undefined>
}

/** SESSION_SECRET present and IDENTITY_ENCRYPTION_KEY a base64 32-byte key (src/lib/crypto.ts). */
export function secretsStatus(env: Record<string, string | undefined>): 'ok' | 'missing' {
  const session = env.SESSION_SECRET ?? ''
  const key = env.IDENTITY_ENCRYPTION_KEY ?? ''
  const keyOk = key !== '' && Buffer.from(key, 'base64').length === 32
  return session.length > 0 && keyOk ? 'ok' : 'missing'
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

async function passes(fn: () => Promise<unknown>, ms: number): Promise<boolean> {
  try {
    await withTimeout(Promise.resolve().then(fn), ms)
    return true
  } catch {
    return false
  }
}

export const defaultHealthDeps: HealthDeps = {
  pingDatabase: () => getDb().execute(sql`select 1`),
  redisConfigured: isCacheConfigured,
  blobConfigured: () => isBlobConfigured(),
  pingRedis: () => getRedis().ping(),
  appliedMigrations: async () => {
    try {
      const res = await getDb().execute(sql.raw(`SELECT filename FROM ${LEDGER_TABLE}`))
      return (res.rows as { filename: string }[]).map((r) => r.filename)
    } catch (e) {
      // No ledger yet (database built by drizzle-kit push, never migrated): pending.
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code
      if (code === '42P01') return []
      throw e
    }
  },
  // Traced into the deployment by outputFileTracingIncludes in next.config.ts.
  migrationFiles: () => orderMigrationNames(fs.readdirSync(path.join(process.cwd(), 'scripts/migrations'))),
  env: process.env,
}

export async function runHealthChecks(deps: HealthDeps = defaultHealthDeps, opts: { timeoutMs?: number } = {}): Promise<HealthReport> {
  const ms = opts.timeoutMs ?? 3000
  const redisConfigured = deps.redisConfigured()
  const [dbOk, redisOk] = await Promise.all([
    passes(deps.pingDatabase, ms),
    redisConfigured ? passes(deps.pingRedis, ms) : Promise.resolve(false),
  ])

  let applied: string[] | null = null
  if (dbOk) {
    try {
      applied = await withTimeout(deps.appliedMigrations(), ms)
    } catch {
      applied = null
    }
  }
  let files: string[] | null = null
  try {
    files = deps.migrationFiles()
  } catch {
    files = null
  }

  const checks: HealthChecks = {
    database: dbOk ? 'ok' : 'fail',
    redis: !redisConfigured ? 'not_configured' : redisOk ? 'ok' : 'fail',
    migrations: migrationStatus(applied, files),
    secrets: secretsStatus(deps.env),
    blob: deps.blobConfigured() ? 'ok' : 'not_configured',
  }
  const status: HealthReport['status'] =
    checks.database === 'fail' || checks.secrets === 'missing' ? 'down'
      : checks.redis !== 'ok' || checks.migrations !== 'up_to_date' || checks.blob !== 'ok' ? 'degraded'
        : 'ok'
  return { status, checks }
}

// A public endpoint must not turn every request into a database and Redis
// round trip: the live report is reused for a few seconds.
let cached: { at: number; report: Promise<HealthReport> } | null = null
export function cachedHealthReport(maxAgeMs = 5000): Promise<HealthReport> {
  const now = Date.now()
  if (!cached || now - cached.at > maxAgeMs) cached = { at: now, report: runHealthChecks() }
  return cached.report
}

export function __resetHealthCacheForTests() {
  cached = null
}
