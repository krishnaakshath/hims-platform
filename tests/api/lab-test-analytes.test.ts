import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'admin'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'Probe Admin', userId: 1 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/lab-analytes', () => ({
  getLabTestWithAnalytes: vi.fn(),
  replaceAnalytesForTest: vi.fn(),
}))

import { GET, PUT } from '@/app/api/lab-tests/[id]/analytes/route'
import { getLabTestWithAnalytes, replaceAnalytesForTest } from '@/lib/queries/lab-analytes'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const get = (id = '9') => GET(new NextRequest(`http://localhost/api/lab-tests/${id}/analytes`), ctx(id))
const put = (body: unknown, id = '9') =>
  PUT(new NextRequest(`http://localhost/api/lab-tests/${id}/analytes`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }), ctx(id))

const HGB = {
  code: 'HGB', name: 'Haemoglobin', unit: 'g/dL', valueType: 'numeric', decimals: 1, loincCode: null, options: null, abnormalOptions: null, criticalOptions: null,
  ranges: [{ sex: 'female', ageMinDays: 6570, ageMaxDays: null, normalLow: 12, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20, displayText: null }],
}
const LOADED = { test: { id: 9, name: 'CBC', code: 'CBC-DIFF' }, analytes: [{ id: 1, ...HGB, isActive: true }] }

beforeEach(() => {
  role = 'admin'
  signedIn = true
  vi.mocked(getLabTestWithAnalytes).mockReset().mockResolvedValue(LOADED as never)
  vi.mocked(replaceAnalytesForTest).mockReset().mockResolvedValue({ ok: true })
})
afterEach(() => vi.restoreAllMocks())

describe('GET /api/lab-tests/[id]/analytes', () => {
  it('admits labs (result entry) and admin', async () => {
    for (const r of ['labs', 'admin']) {
      role = r
      const res = await get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(LOADED)
    }
  })
  it('403s other roles, 401s without a session', async () => {
    for (const r of ['pi', 'frontdesk', 'billing', 'crc', 'collector']) {
      role = r
      expect((await get()).status).toBe(403)
    }
    signedIn = false
    expect((await get()).status).toBe(401)
    expect(getLabTestWithAnalytes).not.toHaveBeenCalled()
  })
  it('404s an unknown test, 400s a bad id', async () => {
    vi.mocked(getLabTestWithAnalytes).mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect((await get('abc')).status).toBe(400)
  })
})

describe('PUT /api/lab-tests/[id]/analytes', () => {
  it('403s labs before parsing the body', async () => {
    role = 'labs'
    const res = await put('{not json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(replaceAnalytesForTest).not.toHaveBeenCalled()
  })
  it('400s unordered range bounds without echoing input', async () => {
    const res = await put({ analytes: [{ ...HGB, ranges: [{ ...HGB.ranges[0], normalLow: 16 }] }] })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('16')
    expect(replaceAnalytesForTest).not.toHaveBeenCalled()
  })
  it('400s unknown keys and non-JSON', async () => {
    expect((await put({ analytes: [HGB], extra: 1 })).status).toBe(400)
    expect((await put('{not json')).status).toBe(400)
  })
  it('saves and returns the reloaded list; 404 for an unknown test', async () => {
    const res = await put({ analytes: [HGB] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(LOADED)
    expect(vi.mocked(replaceAnalytesForTest).mock.calls[0][0]).toBe(9)
    vi.mocked(replaceAnalytesForTest).mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await put({ analytes: [HGB] })).status).toBe(404)
  })
  it('a retryable conflict is a 409', async () => {
    vi.mocked(replaceAnalytesForTest).mockRejectedValue(Object.assign(new Error('x'), { code: '40001' }))
    expect((await put({ analytes: [HGB] })).status).toBe(409)
  })
})
