// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const scheduled: (() => unknown)[] = []
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, after: vi.fn((fn: () => unknown) => { scheduled.push(fn) }) }
})
let rateAllowed = true
vi.mock('@/lib/rate-limit', () => ({ checkAbdmCallbackRateLimit: vi.fn(async () => ({ allowed: rateAllowed })) }))
const verify = vi.fn<(...a: unknown[]) => Promise<{ ok: true } | { ok: false; status: 401 | 403 | 503 }>>(async () => ({ ok: true }))
vi.mock('@/lib/abdm/callback-auth', () => ({ verifyAbdmCallback: (...a: unknown[]) => verify(...a) }))

const rows = new Map<string, { shareId: number; tokenNumber: number }>()
let nextToken = 1
const recordProfileShare = vi.fn(async (input: { requestId: string }) => {
  const seen = rows.get(input.requestId)
  if (seen) return { ...seen, duplicate: true }
  const r = { shareId: rows.size + 1, tokenNumber: nextToken++ }
  rows.set(input.requestId, r)
  return { ...r, duplicate: false }
})
const sendOnShare = vi.fn<(id: number) => Promise<void>>(async () => undefined)
vi.mock('@/lib/queries/abdm-profile-shares', () => ({ recordProfileShare: (i: { requestId: string }) => recordProfileShare(i), sendOnShare: (id: number) => sendOnShare(id) }))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/abdm/api/v3/hip/patient/share/route'

const ENV = {
  ABDM_GATEWAY_BASE_URL: 'https://gw.example', ABHA_BASE_URL: 'https://abha.example', ABDM_CLIENT_ID: 'c', ABDM_CLIENT_SECRET: 's', ABDM_CM_ID: 'sbx',
  ABDM_HIP_ID: 'HFR-1', ABDM_GATEWAY_JWKS_URL: 'https://gw.example/certs',
}
const BODY = {
  intent: 'REGISTRATION',
  metaData: { hipId: 'HFR-1', context: 'C1', hprId: '' },
  profile: { patient: { abhaNumber: '91-1234-5678-9012', abhaAddress: 'asha.rao@sbx', name: 'Asha Rao', gender: 'F', yearOfBirth: '1990', monthOfBirth: '3', dayOfBirth: '12', phoneNumber: '9876500903', address: { line: '12 MG Road', district: 'Mumbai', state: 'Maharashtra', pincode: '400001' } } },
}
const req = (body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new NextRequest('https://app.example/api/abdm/api/v3/hip/patient/share', {
    method: 'POST', body: text, headers: { 'content-length': String(Buffer.byteLength(text)), 'REQUEST-ID': 'req-0000-0001', ...headers },
  })
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v)
  rateAllowed = true; rows.clear(); nextToken = 1; scheduled.length = 0
  vi.clearAllMocks()
  verify.mockResolvedValue({ ok: true })
})
afterEach(() => vi.unstubAllEnvs())

describe('Scan & Share callback', () => {
  it('a valid share is stored, gets token 1 then 2 for the counter, and on-share is scheduled', async () => {
    const r1 = await POST(req(BODY))
    expect(r1.status).toBe(202); expect(await r1.json()).toEqual({})
    const r2 = await POST(req(BODY, { 'REQUEST-ID': 'req-0000-0002' }))
    expect(r2.status).toBe(202)
    expect([...rows.values()].map((r) => r.tokenNumber)).toEqual([1, 2])
    expect(scheduled).toHaveLength(2)
    await scheduled[0]()
    expect(sendOnShare).toHaveBeenCalledWith(1)
    expect(recordProfileShare.mock.calls[0][0]).toMatchObject({
      requestId: 'req-0000-0001', hipId: 'HFR-1', counterId: 'C1', intent: 'REGISTRATION', isMock: false,
      profile: { abhaNumber: '91-1234-5678-9012', name: 'Asha Rao', yearOfBirth: 1990, monthOfBirth: 3, dayOfBirth: 12, phone: '9876500903', pincode: '400001' },
    })
  })
  it('a duplicate REQUEST-ID returns 202 and writes once', async () => {
    expect((await POST(req(BODY))).status).toBe(202)
    expect((await POST(req(BODY))).status).toBe(202)
    expect(rows.size).toBe(1); expect(scheduled).toHaveLength(1)
  })
  it('an oversized body is refused before parsing', async () => {
    const r = await POST(req(BODY, { 'content-length': '20000' }))
    expect(r.status).toBe(413); expect(await r.json()).toEqual({ error: 'Payload too large' })
    expect(verify).not.toHaveBeenCalled(); expect(recordProfileShare).not.toHaveBeenCalled()
  })
  it('a burst from one IP is refused before the JWT check', async () => {
    rateAllowed = false
    expect((await POST(req(BODY))).status).toBe(429); expect(verify).not.toHaveBeenCalled()
  })
  it('an unverified callback is refused before parsing, with fixed bodies', async () => {
    verify.mockResolvedValueOnce({ ok: false, status: 401 })
    const r = await POST(req('{not json'))
    expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: 'Unauthorized' })
    verify.mockResolvedValueOnce({ ok: false, status: 403 })
    expect(await (await POST(req(BODY))).json()).toEqual({ error: 'Forbidden' })
    verify.mockResolvedValueOnce({ ok: false, status: 503 })
    expect(await (await POST(req(BODY))).json()).toEqual({ error: 'Scan and share is not configured' })
    expect(recordProfileShare).not.toHaveBeenCalled()
  })
  it('without ABDM configuration the callback is not configured', async () => {
    vi.stubEnv('ABDM_CLIENT_SECRET', '')
    expect((await POST(req(BODY))).status).toBe(503)
    expect(verify).not.toHaveBeenCalled()
  })
  it('error bodies are fixed and never echo the profile', async () => {
    const bad = { ...BODY, metaData: { hipId: 'HFR-1', context: 'bad counter!' } }
    const r = await POST(req(bad))
    expect(r.status).toBe(400)
    const text = await r.text()
    expect(text).toBe(JSON.stringify({ error: 'Invalid request' }))
    expect((await POST(req('{not json'))).status).toBe(400)
    const other = await POST(req({ ...BODY, metaData: { hipId: 'HFR-9', context: 'C1' } }))
    expect(other.status).toBe(403); expect(await other.text()).not.toContain('Asha')
    expect((await POST(req(BODY, { 'REQUEST-ID': '' }))).status).toBe(400)
    expect(recordProfileShare).not.toHaveBeenCalled()
  })
})
