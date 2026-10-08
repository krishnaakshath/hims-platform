// @vitest-environment node
// A deployment missing Redis or DATABASE_URL must answer a generic 503 (not a
// 500) on the routes that need them, and say exactly what is missing in ONE
// server-side log line -- never to the client. Rate limiting stays fail-closed:
// there is no in-memory fallback.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { ServiceNotConfiguredError, SERVICE_UNAVAILABLE_MESSAGE, isBlobConfigured, serviceErrorResponse, withServiceGuard } from '@/lib/service-config'
import { getRedis } from '@/lib/cache'
import { getDb } from '@/db/client'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const ENV_NAMES = /KV_REST_API|DATABASE_URL|SESSION_SECRET|IDENTITY_ENCRYPTION_KEY|REDIS/

describe('unconfigured services', () => {
  it('getRedis() throws ServiceNotConfiguredError when Redis is not configured', () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    expect(() => getRedis()).toThrow(ServiceNotConfiguredError)
  })

  it('getDb() throws ServiceNotConfiguredError when DATABASE_URL is not set', () => {
    vi.stubEnv('DATABASE_URL', '')
    expect(() => getDb()).toThrow(ServiceNotConfiguredError)
  })
})

describe('withServiceGuard', () => {
  it('turns a missing Redis into a generic 503 and one clear log line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = withServiceGuard('login', async () => { throw new ServiceNotConfiguredError('redis') })
    const res = await handler()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ error: SERVICE_UNAVAILABLE_MESSAGE })
    expect(SERVICE_UNAVAILABLE_MESSAGE).toBe('Service temporarily unavailable')
    expect(JSON.stringify(body)).not.toMatch(ENV_NAMES)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('[config] REDIS not configured: login is unavailable')
  })

  it('turns a missing blob store into a 503 naming the token in the log only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await withServiceGuard('lab report download', async () => { throw new ServiceNotConfiguredError('blob') })()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: SERVICE_UNAVAILABLE_MESSAGE })
    expect(log.mock.calls).toEqual([['[config] BLOB_READ_WRITE_TOKEN not configured: lab report download is unavailable']])
  })

  it('turns a missing DATABASE_URL into a 503', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await withServiceGuard('login', async () => { throw new ServiceNotConfiguredError('database') })()
    expect(res.status).toBe(503)
    expect(log.mock.calls[0][0]).toBe('[config] DATABASE_URL not configured: login is unavailable')
  })

  it('turns an unreachable database (connection refused, wrong password, missing database) into a 503 with the code only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const code of ['ECONNREFUSED', '28P01', '3D000']) {
      const err = Object.assign(new Error('password authentication failed for user "neondb_owner"'), { code })
      // drizzle wraps driver errors; the code is on the cause
      const wrapped = Object.assign(new Error('Failed query: select ...'), { cause: err })
      const res = await withServiceGuard('patient login', async () => { throw wrapped })()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: SERVICE_UNAVAILABLE_MESSAGE })
    }
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[config] database unreachable (ECONNREFUSED): patient login is unavailable',
      '[config] database unreachable (28P01): patient login is unavailable',
      '[config] database unreachable (3D000): patient login is unavailable',
    ])
    expect(log.mock.calls.flat().join(' ')).not.toContain('neondb_owner')
  })

  it('rethrows every other error unchanged', async () => {
    const boom = new Error('bug')
    await expect(withServiceGuard('login', async () => { throw boom })()).rejects.toBe(boom)
  })

  it('passes the handler response and arguments through', async () => {
    const handler = withServiceGuard('x', async (a: number, b: string) => new Response(`${a}${b}`, { status: 201 }))
    const res = await handler(1, 'z')
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('1z')
  })
})

describe('isBlobConfigured', () => {
  it('needs a read-write token or a store id (OIDC)', () => {
    expect(isBlobConfigured({})).toBe(false)
    expect(isBlobConfigured({ BLOB_READ_WRITE_TOKEN: '  ' })).toBe(false)
    expect(isBlobConfigured({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' })).toBe(true)
    expect(isBlobConfigured({ BLOB_STORE_ID: 'store_x' })).toBe(true)
  })
})

describe('serviceErrorResponse', () => {
  it('is null for an ordinary error and logs nothing', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(serviceErrorResponse(new Error('bug'), 'x')).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })
})

describe('POST /api/login without Redis', () => {
  it('answers 503 Service temporarily unavailable, not 500, and does not fall back to an in-memory limiter', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { POST } = await import('@/app/api/login/route')
    const req = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.test', password: 'whatever-123' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
    })
    const res = await POST(req)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' })
    expect(log).toHaveBeenCalledWith('[config] REDIS not configured: login is unavailable')
  })
})
