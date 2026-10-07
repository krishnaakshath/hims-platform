import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const store = new Map<string, unknown>()

vi.mock('@upstash/redis', () => ({
  Redis: class {
    async get(key: string) { return store.get(key) ?? null }
    async set(key: string, value: unknown) { store.set(key, value) }
    async del(key: string) { store.delete(key) }
  },
}))

import { getOrSetCache, invalidateCache } from '@/lib/cache'

describe('getOrSetCache', () => {
  beforeEach(() => {
    store.clear()
    // the cache is only active when Redis is configured
    vi.stubEnv('KV_REST_API_URL', 'https://redis.example.test')
    vi.stubEnv('KV_REST_API_TOKEN', 'dummy')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('calls the loader and caches the result on a miss', async () => {
    const loader = vi.fn().mockResolvedValue({ hello: 'world' })
    const result = await getOrSetCache('key-1', 60, loader)
    expect(result).toEqual({ hello: 'world' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns the cached value without calling the loader again on a hit', async () => {
    const loader = vi.fn().mockResolvedValue({ hello: 'world' })
    await getOrSetCache('key-2', 60, loader)
    await getOrSetCache('key-2', 60, loader)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('invalidateCache forces the next call to hit the loader again', async () => {
    const loader = vi.fn().mockResolvedValue({ v: 1 })
    await getOrSetCache('key-3', 60, loader)
    await invalidateCache('key-3')
    await getOrSetCache('key-3', 60, loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
