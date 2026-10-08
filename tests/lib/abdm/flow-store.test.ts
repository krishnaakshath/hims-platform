import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

const store = new Map<string, string>()
const redis = {
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  del: vi.fn(async (k: string) => { store.delete(k); return 1 }),
}
vi.mock('@/lib/cache', () => ({ getRedis: () => redis }))

import { createFlow, deleteFlow, getFlow, saveFlow } from '@/lib/abdm/flow-store'

beforeEach(() => {
  store.clear(); vi.clearAllMocks()
  process.env.INTEGRATION_PAYLOAD_KEY = randomBytes(32).toString('base64')
})

describe('ABHA flow store', () => {
  it('stores sealed state with a 900 s TTL and refuses another staff member', async () => {
    const f = await createFlow({ staffName: 'A', staffUserId: 1, patientId: null, kind: 'enrolment' })
    expect(f.flowId).toMatch(/^[0-9a-f-]{36}$/)
    expect(redis.set).toHaveBeenCalledWith(`abdm:flow:${f.flowId}`, expect.not.stringContaining('enrolment'), { ex: 900 })
    expect(await getFlow(f.flowId, 'B')).toBeNull()
    expect(await getFlow(f.flowId, 'A')).toEqual(f)
  })
  it('saves updates and deletes', async () => {
    const f = await createFlow({ staffName: 'A', staffUserId: null, patientId: 'RD-1', kind: null })
    await saveFlow({ ...f, txnId: 'txn-1', userToken: 'tok' })
    const stored = store.get(`abdm:flow:${f.flowId}`)!
    expect(stored).not.toMatch(/txn-1|tok/)
    expect((await getFlow(f.flowId, 'A'))!.txnId).toBe('txn-1')
    await deleteFlow(f.flowId)
    expect(await getFlow(f.flowId, 'A')).toBeNull()
  })
  it('an unreadable entry is no flow', async () => {
    const id = '0b6c7c5e-6d3f-4d4c-9a51-2f7d4f0d9f11'
    store.set(`abdm:flow:${id}`, 'garbage')
    expect(await getFlow(id, 'A')).toBeNull()
    expect(redis.get).toHaveBeenCalled()
  })
  it('a malformed flow id never reaches Redis', async () => {
    expect(await getFlow('../../etc', 'A')).toBeNull()
    expect(redis.get).not.toHaveBeenCalled()
  })
})
