// @vitest-environment node
// GET /api/health and /api/health/ready are public (no session): uptime
// monitors and deploy checks call them. They must never reveal an env var
// name, a value, or error text -- only fixed status words.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runHealthChecks, secretsStatus, type HealthDeps } from '@/lib/config-check'
import { BASELINE_NAME } from '@/db/migrations'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => { throw new Error('health must not require a session') }) }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const KEY32 = Buffer.alloc(32, 7).toString('base64')
const okDeps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
  pingDatabase: async () => {},
  redisConfigured: () => true,
  pingRedis: async () => {},
  appliedMigrations: async () => [BASELINE_NAME, 'a.sql'],
  migrationFiles: () => ['a.sql'],
  env: { SESSION_SECRET: 'x'.repeat(48), IDENTITY_ENCRYPTION_KEY: KEY32 },
  ...over,
})

describe('secretsStatus', () => {
  it('is ok with a session secret and a 32-byte identity key', () => {
    expect(secretsStatus({ SESSION_SECRET: 'x'.repeat(48), IDENTITY_ENCRYPTION_KEY: KEY32 })).toBe('ok')
  })
  it('is missing when either is absent or the key is the wrong length', () => {
    expect(secretsStatus({ IDENTITY_ENCRYPTION_KEY: KEY32 })).toBe('missing')
    expect(secretsStatus({ SESSION_SECRET: 'x'.repeat(48) })).toBe('missing')
    expect(secretsStatus({ SESSION_SECRET: 'x'.repeat(48), IDENTITY_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toBe('missing')
  })
})

describe('runHealthChecks', () => {
  it('reports ok when everything is in place', async () => {
    expect(await runHealthChecks(okDeps())).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok', migrations: 'up_to_date', secrets: 'ok' },
    })
  })

  it('reports each failure as a fixed word, never the error text', async () => {
    const report = await runHealthChecks(okDeps({
      pingDatabase: async () => { throw new Error('password authentication failed for user "neondb_owner" postgres://u:p@h/db') },
      redisConfigured: () => false,
      appliedMigrations: async () => { throw new Error('boom') },
      env: {},
    }))
    expect(report).toEqual({
      status: 'down',
      checks: { database: 'fail', redis: 'not_configured', migrations: 'unknown', secrets: 'missing' },
    })
  })

  it('is degraded (not down) when only Redis or migrations are wrong', async () => {
    const r1 = await runHealthChecks(okDeps({ pingRedis: async () => { throw new Error('x') } }))
    expect(r1).toEqual({ status: 'degraded', checks: { database: 'ok', redis: 'fail', migrations: 'up_to_date', secrets: 'ok' } })
    const r2 = await runHealthChecks(okDeps({ appliedMigrations: async () => [BASELINE_NAME] , migrationFiles: () => ['a.sql', 'b.sql'] }))
    expect(r2.checks.migrations).toBe('pending')
    expect(r2.status).toBe('degraded')
  })

  it('reports migrations unknown when the database is down', async () => {
    const r = await runHealthChecks(okDeps({ pingDatabase: async () => { throw new Error('x') } }))
    expect(r.checks.migrations).toBe('unknown')
  })

  it('times out a hanging check instead of hanging the request', async () => {
    const r = await runHealthChecks(okDeps({ pingRedis: () => new Promise(() => {}) }), { timeoutMs: 50 })
    expect(r.checks.redis).toBe('fail')
  })
})

describe('GET /api/health and /api/health/ready', () => {
  const ENV_LEAK = /KV_REST|DATABASE_URL|SESSION_SECRET|IDENTITY_ENCRYPTION|postgres:|neon|password|Error/i

  it('answers with exactly {status, checks} and no session, no env names, no error text', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    const { GET } = await import('@/app/api/health/route')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['checks', 'status'])
    expect(Object.keys(body.checks).sort()).toEqual(['database', 'migrations', 'redis', 'secrets'])
    expect(body.checks.redis).toBe('not_configured')
    expect(JSON.stringify(body)).not.toMatch(ENV_LEAK)
  })

  it('/ready answers 503 unless every check passes', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    const { GET } = await import('@/app/api/health/ready/route')
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).not.toBe('ok')
    expect(JSON.stringify(body)).not.toMatch(ENV_LEAK)
  })

  it('is outside the staff-session proxy (the matcher excludes /api)', async () => {
    const { config } = await import('@/proxy')
    const re = new RegExp(`^${config.matcher[0]}$`)
    expect(re.test('/api/health')).toBe(false)
    expect(re.test('/api/health/ready')).toBe(false)
    expect(re.test('/patients')).toBe(true)
  })
})
