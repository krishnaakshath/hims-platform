// WS6 T11: POST /api/home-collections/[id]/otp, with the session, the guard, the limiter and the
// issuer mocked. The response carries the channel status only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let role: Role = 'collector'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'TEST_WS6_probe', userId: 7 })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/home-collections', () => ({ assertCollectorVisit: vi.fn() }))
vi.mock('@/lib/home-collection/handover-otp', () => ({ issueHandoverOtp: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ checkHandoverOtpSendRateLimit: vi.fn(async () => ({ allowed: true })) }))

import { POST } from '@/app/api/home-collections/[id]/otp/route'
import { assertCollectorVisit } from '@/lib/queries/home-collections'
import { issueHandoverOtp } from '@/lib/home-collection/handover-otp'
import { checkHandoverOtpSendRateLimit } from '@/lib/rate-limit'

const send = (body: unknown = {}, id = '77') =>
  POST(new NextRequest(`http://localhost/api/home-collections/${id}/otp`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  role = 'collector'
  vi.mocked(assertCollectorVisit).mockReset().mockResolvedValue({ ok: true, patientId: 'RD-0001' })
  vi.mocked(issueHandoverOtp).mockReset().mockResolvedValue({ ok: true, channelStatus: 'log_only' })
  vi.mocked(checkHandoverOtpSendRateLimit).mockClear().mockResolvedValue({ allowed: true })
})

describe('POST /api/home-collections/[id]/otp', () => {
  it.each(['frontdesk', 'labs', 'billing', 'pharmacy', 'doctor'] as Role[])('%s is 403 before parsing', async (r) => {
    role = r
    expect((await send('not json')).status).toBe(403)
    expect(assertCollectorVisit).not.toHaveBeenCalled()
  })

  it('200 with the channel status only', async () => {
    const res = await send({})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ channelStatus: 'log_only' })
    expect(checkHandoverOtpSendRateLimit).toHaveBeenCalledWith(77)
    expect(issueHandoverOtp).toHaveBeenCalledWith(77, expect.objectContaining({ role: 'collector' }))
  })

  it('a body with keys, bad JSON or a bad id is 400 before any lookup', async () => {
    expect((await send({ otp: '123456' })).status).toBe(400)
    expect((await send('nope')).status).toBe(400)
    expect((await send({}, 'abc')).status).toBe(400)
    expect(assertCollectorVisit).not.toHaveBeenCalled()
  })

  it("the door guard runs before the limiter: another collector's visit is 403, tomorrow's is 409", async () => {
    vi.mocked(assertCollectorVisit).mockResolvedValueOnce({ ok: false, error: 'not_assigned' })
    expect((await send()).status).toBe(403)
    vi.mocked(assertCollectorVisit).mockResolvedValueOnce({ ok: false, error: 'not_due', visitDate: '2026-10-24' })
    const due = await send()
    expect(due.status).toBe(409)
    expect((await due.json()).error).toBe('This visit is on 24 Oct 2026. It can be collected on that day.')
    vi.mocked(assertCollectorVisit).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await send()).status).toBe(404)
    vi.mocked(assertCollectorVisit).mockResolvedValueOnce({ ok: false, error: 'not_collectable' })
    expect((await send()).status).toBe(409)
    expect(checkHandoverOtpSendRateLimit).not.toHaveBeenCalled()
    expect(issueHandoverOtp).not.toHaveBeenCalled()
  })

  it('the fourth send in 15 minutes is a 429; no phone is a 409', async () => {
    vi.mocked(checkHandoverOtpSendRateLimit).mockResolvedValueOnce({ allowed: false })
    expect((await send()).status).toBe(429)
    expect(issueHandoverOtp).not.toHaveBeenCalled()
    vi.mocked(issueHandoverOtp).mockResolvedValueOnce({ ok: false, error: 'no_phone' })
    const res = await send()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('no_phone')
  })
})
