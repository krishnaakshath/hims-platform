// SP5 Task 8: the lab lifecycle routes (collect, receive, result, verify, cancel), with the
// lifecycle queries, the session and the audit log mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

let role: Role = 'labs'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'TEST_SP5_probe', userId: 41 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/lab-lifecycle', () => ({
  collectLabOrder: vi.fn(),
  receiveLabSample: vi.fn(),
  recordLabResult: vi.fn(),
  verifyLabResult: vi.fn(),
  cancelLabOrder: vi.fn(),
}))

import { POST as COLLECT } from '@/app/api/lab-orders/[id]/collect/route'
import { POST as RECEIVE } from '@/app/api/lab-orders/receive/route'
import { POST as RESULT } from '@/app/api/lab-orders/[id]/result/route'
import { POST as VERIFY } from '@/app/api/lab-orders/[id]/verify/route'
import { POST as CANCEL } from '@/app/api/lab-orders/[id]/cancel/route'
import { collectLabOrder, receiveLabSample, recordLabResult, verifyLabResult, cancelLabOrder } from '@/lib/queries/lab-lifecycle'
import { logAudit } from '@/lib/audit'

const post = (body?: unknown) =>
  new NextRequest('http://localhost/api/lab-orders/x', { method: 'POST', ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
const send = post
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const RESULT_BODY = { value: '5.2', unit: 'mg/dL', flag: 'normal' }
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })

beforeEach(() => {
  role = 'labs'
  signedIn = true
  for (const fn of [collectLabOrder, receiveLabSample, recordLabResult, verifyLabResult, cancelLabOrder, logAudit]) vi.mocked(fn).mockReset()
})

describe('POST /api/lab-orders/[id]/result', () => {
  it.each(['pi', 'crc', 'frontdesk', 'collector'] as const)('%s cannot enter a result (403, query not called)', async (r) => {
    role = r
    const res = await RESULT(send('{not json'), ctx('4'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(recordLabResult).not.toHaveBeenCalled()
  })

  it('labs records a staff result through recordLabResult', async () => {
    vi.mocked(recordLabResult).mockResolvedValue({ ok: true, patientId: 'RD-1', amended: false })
    const res = await RESULT(send(RESULT_BODY), ctx('4'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(recordLabResult).toHaveBeenCalledWith(4, RESULT_BODY, { kind: 'staff', session: expect.objectContaining({ role: 'labs' }) })
  })

  it('400s bad JSON, an invalid body and a bad id before any query', async () => {
    expect((await RESULT(send('{not json'), ctx('4'))).status).toBe(400)
    const bad = await RESULT(send({ ...RESULT_BODY, flag: 'weird-SECRET' }), ctx('4'))
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).not.toContain('SECRET')
    expect((await RESULT(send(RESULT_BODY), ctx('abc'))).status).toBe(400)
    expect(recordLabResult).not.toHaveBeenCalled()
  })

  it('maps invalid_status and not_found', async () => {
    vi.mocked(recordLabResult).mockResolvedValue({ ok: false, error: 'invalid_status' })
    const res = await RESULT(send(RESULT_BODY), ctx('4'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This order is not at a stage where that can be done.' })
    vi.mocked(recordLabResult).mockResolvedValue({ ok: false, error: 'not_found' })
    const nf = await RESULT(send(RESULT_BODY), ctx('4'))
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'Lab order not found' })
  })

  it('a deadlock is a 409 asking to retry', async () => {
    vi.mocked(recordLabResult).mockRejectedValue(deadlock())
    const res = await RESULT(send(RESULT_BODY), ctx('4'))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/try again/)
  })

  it('401s without a session', async () => {
    signedIn = false
    expect((await RESULT(send(RESULT_BODY), ctx('4'))).status).toBe(401)
  })
})

describe('POST /api/lab-orders/[id]/verify', () => {
  it('pi verifies; labs cannot', async () => {
    role = 'labs'
    expect((await VERIFY(post(), ctx('4'))).status).toBe(403)
    expect(verifyLabResult).not.toHaveBeenCalled()
    role = 'pi'
    vi.mocked(verifyLabResult).mockResolvedValue({ ok: true } as never)
    const res = await VERIFY(post(), ctx('4'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(verifyLabResult).toHaveBeenCalledWith(4, expect.objectContaining({ role: 'pi' }))
  })

  it.each(['crc', 'frontdesk', 'collector', 'billing', 'pharmacy'] as const)('%s is denied', async (r) => {
    role = r
    const res = await VERIFY(post(), ctx('4'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('maps self_verification to 409 with the message', async () => {
    role = 'pi'
    vi.mocked(verifyLabResult).mockResolvedValue({ ok: false, error: 'self_verification' })
    const res = await VERIFY(post(), ctx('4'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Results must be verified by someone other than the person who entered them.' })
  })

  it('400s a bad id before any query', async () => {
    role = 'admin'
    expect((await VERIFY(post(), ctx('0'))).status).toBe(400)
    expect(verifyLabResult).not.toHaveBeenCalled()
  })
})

describe('POST /api/lab-orders/receive', () => {
  it('receive 400s a bad check digit before any DB call', async () => {
    role = 'labs'
    const res = await RECEIVE(send({ sampleId: 'L26100800439' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'That sample ID is not valid. Re-scan or re-type it.' })
    expect(receiveLabSample).not.toHaveBeenCalled()
  })

  it('receives a grouped, lower-case sample ID and returns the canonical one', async () => {
    vi.mocked(receiveLabSample).mockResolvedValue({ ok: true, order: { id: 9, sampleId: 'L26100800429' } as never })
    const res = await RECEIVE(send({ sampleId: 'l261008-0042-9' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orderId: 9, sampleId: 'L26100800429' })
    expect(receiveLabSample).toHaveBeenCalledWith('L26100800429', expect.objectContaining({ role: 'labs' }))
  })

  it('maps not_found and already_received', async () => {
    vi.mocked(receiveLabSample).mockResolvedValue({ ok: false, error: 'not_found' })
    const nf = await RECEIVE(send({ sampleId: 'L26100800429' }))
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'No lab order has that sample ID.' })
    vi.mocked(receiveLabSample).mockResolvedValue({ ok: false, error: 'already_received' })
    const dup = await RECEIVE(send({ sampleId: 'L26100800429' }))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'This sample has already been received.' })
    vi.mocked(receiveLabSample).mockResolvedValue({ ok: false, error: 'invalid_status' })
    expect((await RECEIVE(send({ sampleId: 'L26100800429' }))).status).toBe(409)
  })

  it.each(['pi', 'crc', 'frontdesk', 'collector'] as const)('%s is denied before parse', async (r) => {
    role = r
    const res = await RECEIVE(send('{not json'))
    expect(res.status).toBe(403)
    expect(receiveLabSample).not.toHaveBeenCalled()
  })

  it('never echoes the scanned text', async () => {
    const res = await RECEIVE(send({ sampleId: 'XSECRETX' }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('SECRET')
  })
})

describe('POST /api/lab-orders/[id]/collect', () => {
  it('returns the sample ID', async () => {
    vi.mocked(collectLabOrder).mockResolvedValue({ ok: true, order: {} as never, sampleId: 'L26100800429' })
    const res = await COLLECT(post(), ctx('4'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sampleId: 'L26100800429' })
    expect(collectLabOrder).toHaveBeenCalledWith(4, expect.objectContaining({ role: 'labs' }))
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('maps booked_for_home', async () => {
    vi.mocked(collectLabOrder).mockResolvedValue({ ok: false, error: 'booked_for_home' })
    const res = await COLLECT(post(), ctx('4'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This test is booked for home collection. Cancel the home visit first.' })
  })

  it.each(['crc', 'frontdesk', 'collector'] as const)('%s is denied', async (r) => {
    role = r
    expect((await COLLECT(post(), ctx('4'))).status).toBe(403)
    expect(collectLabOrder).not.toHaveBeenCalled()
  })
})

describe('POST /api/lab-orders/[id]/cancel', () => {
  it('cancel never puts the reason in the audit log', async () => {
    role = 'pi'
    vi.mocked(cancelLabOrder).mockResolvedValue({ ok: true, patientId: 'RD-1', cancelledVisitId: null })
    const res = await CANCEL(send({ reason: 'SECRETWORD patient left' }), ctx('4'))
    expect(res.status).toBe(200)
    expect(cancelLabOrder).toHaveBeenCalledWith(4, 'SECRETWORD patient left', expect.objectContaining({ role: 'pi' }))
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('maps not_cancellable', async () => {
    role = 'admin'
    vi.mocked(cancelLabOrder).mockResolvedValue({ ok: false, error: 'not_cancellable' })
    const res = await CANCEL(send({ reason: 'x' }), ctx('4'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Only tests without a result can be cancelled.' })
  })

  it.each(['labs', 'crc', 'frontdesk', 'collector'] as const)('%s is denied before parse', async (r) => {
    role = r
    const res = await CANCEL(send('{not json'), ctx('4'))
    expect(res.status).toBe(403)
    expect(cancelLabOrder).not.toHaveBeenCalled()
  })

  it('400s an empty reason without echoing it', async () => {
    role = 'pi'
    expect((await CANCEL(send({ reason: '   ' }), ctx('4'))).status).toBe(400)
    expect(cancelLabOrder).not.toHaveBeenCalled()
  })
})
