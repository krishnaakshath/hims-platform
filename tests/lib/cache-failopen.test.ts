import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const redis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
}
vi.mock('@upstash/redis', () => ({ Redis: class { get = redis.get; set = redis.set; del = redis.del; keys = redis.keys } }))

import { getOrSetCache, invalidateCache, invalidateCacheByPrefix } from '@/lib/cache'

const SECRET = 'tok_SECRET_123'

describe('cache fails open', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let err: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('KV_REST_API_URL', 'https://redis.example.test')
    vi.stubEnv('KV_REST_API_TOKEN', 'dummy')
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    err = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.unstubAllEnvs() })

  const logged = () => [...warn.mock.calls, ...err.mock.calls].flat().map(String).join(' ')

  it('treats a rejecting read as a miss and calls the loader exactly once', async () => {
    redis.get.mockRejectedValue(new Error(`timeout Bearer ${SECRET}`))
    redis.set.mockResolvedValue('OK')
    const loader = vi.fn().mockResolvedValue({ v: 1 })
    await expect(getOrSetCache('k', 60, loader)).resolves.toEqual({ v: 1 })
    expect(loader).toHaveBeenCalledTimes(1)
    expect(logged()).not.toContain(SECRET)
    expect(logged().length).toBeGreaterThan(0)
  })

  it('returns the loaded value even when the write-back fails', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockRejectedValue(new Error('timeout'))
    const loader = vi.fn().mockResolvedValue('x')
    await expect(getOrSetCache('k', 60, loader)).resolves.toBe('x')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not swallow loader errors', async () => {
    redis.get.mockResolvedValue(null)
    await expect(getOrSetCache('k', 60, () => Promise.reject(new Error('db down')))).rejects.toThrow('db down')
  })

  it('invalidateCache does not throw and logs loudly', async () => {
    redis.del.mockRejectedValue(new Error(`boom ${SECRET}`))
    await expect(invalidateCache('k')).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    expect(logged()).toContain('k')
    expect(logged()).not.toContain(SECRET)
  })

  it('invalidateCacheByPrefix does not throw when keys or del fail', async () => {
    redis.keys.mockRejectedValue(new Error('timeout'))
    await expect(invalidateCacheByPrefix('p:')).resolves.toBeUndefined()
    redis.keys.mockResolvedValue(['p:1'])
    redis.del.mockRejectedValue(new Error('timeout'))
    await expect(invalidateCacheByPrefix('p:')).resolves.toBeUndefined()
    expect(err).toHaveBeenCalledTimes(2)
  })

  it('with no Redis configured: loads straight from the loader and never touches Redis', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    const loader = vi.fn().mockResolvedValue('db')
    await expect(getOrSetCache('k', 60, loader)).resolves.toBe('db')
    await invalidateCache('k')
    await invalidateCacheByPrefix('p:')
    expect(loader).toHaveBeenCalledTimes(1)
    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
    expect(redis.keys).not.toHaveBeenCalled()
  })
})
