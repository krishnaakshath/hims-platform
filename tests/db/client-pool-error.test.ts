import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const poolInstances: Array<EventEmitter & { opts: Record<string, unknown> }> = []

vi.mock('pg', () => ({
  Pool: class extends EventEmitter {
    opts: Record<string, unknown>
    constructor(opts: Record<string, unknown>) {
      super()
      this.opts = opts
      poolInstances.push(this as never)
    }
  },
}))
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: vi.fn(() => ({})) }))

describe('db pool', () => {
  beforeEach(() => {
    poolInstances.length = 0
    vi.resetModules()
    process.env.DATABASE_URL = 'postgres://user:s3cretpw@host.example/db'
  })

  it('registers an error listener so an idle-client reset does not crash the process', async () => {
    const { getDb } = await import('@/db/client')
    getDb()
    expect(poolInstances).toHaveLength(1)
    expect(poolInstances[0].listenerCount('error')).toBeGreaterThan(0)
  })

  it('logs one concise message without credentials when the pool emits error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getDb } = await import('@/db/client')
    getDb()
    const err = new Error('read ECONNRESET postgres://user:s3cretpw@host.example/db SELECT * FROM patients')
    expect(() => poolInstances[0].emit('error', err)).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    const text = spy.mock.calls[0].map(String).join(' ')
    expect(text).not.toContain('s3cretpw')
    expect(text).not.toContain('postgres://')
    expect(text).not.toContain('SELECT')
    spy.mockRestore()
  })

  it('sets connection and idle timeouts without changing max or ssl', async () => {
    const { getDb } = await import('@/db/client')
    getDb()
    const o = poolInstances[0].opts
    expect(o.connectionTimeoutMillis).toBe(10_000)
    expect(o.idleTimeoutMillis).toBe(30_000)
    expect(o.ssl).toEqual({ rejectUnauthorized: false })
    expect(o.max).toBeUndefined()
  })
})
