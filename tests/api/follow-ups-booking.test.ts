import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'frontdesk'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'Probe Desk', userId: 5 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/follow-up-recall', () => ({ bookFollowUp: vi.fn(), unbookFollowUp: vi.fn(), recordContactAttempt: vi.fn() }))
vi.mock('@/lib/queries/follow-ups', () => ({ getFollowUpView: vi.fn() }))
vi.mock('@/lib/follow-ups/notifier', () => ({ notifyFollowUpSafely: vi.fn(async () => undefined) }))

import { PUT } from '@/app/api/follow-ups/[id]/booking/route'
import { POST as UNBOOK } from '@/app/api/follow-ups/[id]/unbook/route'
import { POST as CONTACT } from '@/app/api/follow-ups/[id]/contact-attempts/route'
import { bookFollowUp, recordContactAttempt, unbookFollowUp } from '@/lib/queries/follow-up-recall'
import { getFollowUpView } from '@/lib/queries/follow-ups'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'

const send = (method: 'POST' | 'PUT', path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (p: { id: string }) => ({ params: Promise.resolve(p) })

// The raw row carries clinical text; the route must answer with the role view instead.
const ORDER = { id: 3, patientId: 'RD-0001', dueDate: '2026-10-21', planNotes: 'RAW-PLAN-NOTES', cancelReason: 'RAW-CANCEL-REASON' }
const VIEW = { id: 3, patientId: 'RD-0001', dueDate: '2026-10-21', planNotes: null, cancelReason: null }
const SLOT = { providerId: 1, startsAt: '2026-10-22T00:30:00+05:30', endsAt: '2026-10-22T00:45:00+05:30' }
const ATTEMPT = { id: 9, followUpOrderId: 3, channel: 'phone', outcome: 'no_answer', note: 'busy tone', attemptedByName: 'Probe Desk', attemptedByUserId: 5, attemptedAt: new Date('2026-10-20T04:00:00Z') }
const DENIED = ['pi', 'crc', 'billing', 'labs', 'pharmacy', 'coder'] as const

beforeEach(() => {
  role = 'frontdesk'
  signedIn = true
  vi.mocked(bookFollowUp).mockReset().mockResolvedValue({ ok: true, order: ORDER as never, appointmentId: 44, kind: 'booked' })
  vi.mocked(unbookFollowUp).mockReset().mockResolvedValue({ ok: true, order: ORDER as never, cancelledAppointmentId: 44 })
  vi.mocked(recordContactAttempt).mockReset().mockResolvedValue({ ok: true, attempt: ATTEMPT as never })
  vi.mocked(getFollowUpView).mockReset().mockResolvedValue(VIEW as never)
  vi.mocked(notifyFollowUpSafely).mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('role gate (inline, before parse)', () => {
  it.each(DENIED)('%s cannot book, unbook or log a contact (403, query not called)', async (r) => {
    role = r
    const responses = [
      await PUT(send('PUT', '/api/follow-ups/3/booking', '{not json'), ctx({ id: '3' })),
      await UNBOOK(send('POST', '/api/follow-ups/3/unbook', '{not json'), ctx({ id: '3' })),
      await CONTACT(send('POST', '/api/follow-ups/3/contact-attempts', '{not json'), ctx({ id: '3' })),
    ]
    for (const res of responses) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(bookFollowUp).not.toHaveBeenCalled()
    expect(unbookFollowUp).not.toHaveBeenCalled()
    expect(recordContactAttempt).not.toHaveBeenCalled()
  })

  it('unauthenticated is 401', async () => {
    signedIn = false
    expect((await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))).status).toBe(401)
    expect((await UNBOOK(send('POST', '/api/follow-ups/3/unbook', { reason: 'x' }), ctx({ id: '3' }))).status).toBe(401)
    expect((await CONTACT(send('POST', '/api/follow-ups/3/contact-attempts', { channel: 'phone', outcome: 'no_answer' }), ctx({ id: '3' }))).status).toBe(401)
  })

  it('admin is allowed; unparseable JSON is 400 Invalid JSON', async () => {
    role = 'admin'
    expect((await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))).status).toBe(200)
    const res = await PUT(send('PUT', '/api/follow-ups/3/booking', '{not json'), ctx({ id: '3' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
  })
})

describe('PUT /api/follow-ups/[id]/booking', () => {
  it('rejects a slot without an explicit offset with 400 before calling bookFollowUp', async () => {
    const res = await PUT(send('PUT', '/api/follow-ups/3/booking', { providerId: 1, startsAt: '2026-10-21T09:30:00', endsAt: '2026-10-21T09:45:00' }), ctx({ id: '3' }))
    expect(res.status).toBe(400)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('2026-10-21T09:30')
    expect(bookFollowUp).not.toHaveBeenCalled()
  })

  it('passes the IST slot through as the exact instant', async () => {
    await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    const [id, slot, session] = vi.mocked(bookFollowUp).mock.calls[0]
    expect(id).toBe(3)
    expect(slot.startsAt.toISOString()).toBe('2026-10-21T19:00:00.000Z')
    expect(slot.endsAt.toISOString()).toBe('2026-10-21T19:15:00.000Z')
    expect(slot.providerId).toBe(1)
    expect(session).toMatchObject({ role: 'frontdesk' })
  })

  it('answers with the front-desk view, never the raw row (no plan notes, no cancel reason)', async () => {
    const res = await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ order: VIEW, appointmentId: 44, kind: 'booked' })
    expect(getFollowUpView).toHaveBeenCalledWith(3, 'frontdesk')
    expect(JSON.stringify(body)).not.toMatch(/RAW-/)
  })

  it.each([
    ['conflict', 409, 'This doctor already has an appointment during that time.'],
    ['slot_in_past', 400, 'Pick a time later than now.'],
    ['not_bookable', 409, 'This follow-up is already completed or cancelled.'],
    ['not_found', 404, 'Follow-up not found'],
    ['provider_not_found', 404, 'Doctor not found or inactive'],
  ] as const)('maps %s to %i', async (error, status, message) => {
    vi.mocked(bookFollowUp).mockResolvedValueOnce({ ok: false, error })
    const res = await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('notifies booked vs rescheduled with the appointment time, after the write', async () => {
    await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    expect(notifyFollowUpSafely).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'frontdesk' }), {
      kind: 'booked', followUpOrderId: 3, patientId: 'RD-0001', dueDate: '2026-10-21', appointmentStartsAt: new Date('2026-10-21T19:00:00.000Z'),
    })
    expect(vi.mocked(bookFollowUp).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(notifyFollowUpSafely).mock.invocationCallOrder[0])
    vi.mocked(bookFollowUp).mockResolvedValueOnce({ ok: true, order: ORDER as never, appointmentId: 44, kind: 'rescheduled' })
    const res = await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    expect((await res.json()).kind).toBe('rescheduled')
    expect(notifyFollowUpSafely).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'rescheduled', appointmentStartsAt: new Date('2026-10-21T19:00:00.000Z') }))
  })

  it('rejects unknown keys, end before start, and a bad id with 400', async () => {
    for (const body of [{ ...SLOT, extra: 1 }, { ...SLOT, endsAt: SLOT.startsAt }, { ...SLOT, startsAt: '2026-02-30T10:00:00+05:30' }]) {
      expect((await PUT(send('PUT', '/api/follow-ups/3/booking', body), ctx({ id: '3' }))).status).toBe(400)
    }
    expect((await PUT(send('PUT', '/api/follow-ups/x/booking', SLOT), ctx({ id: 'x' }))).status).toBe(400)
    expect(bookFollowUp).not.toHaveBeenCalled()
  })

  it('a deadlock is a 409 asking to try again; other errors a 500 that logs only the code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(bookFollowUp).mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: '40001' }))
    const retry = await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    expect(retry.status).toBe(409)
    expect((await retry.json()).error).toMatch(/try again/)
    vi.mocked(bookFollowUp).mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: '23514' }))
    const failed = await PUT(send('PUT', '/api/follow-ups/3/booking', SLOT), ctx({ id: '3' }))
    expect(failed.status).toBe(500)
    const logged = spy.mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('23514')
    expect(logged).not.toContain('SECRET')
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })
})

describe('POST /api/follow-ups/[id]/unbook', () => {
  it('200 with the view, then notifies unbooked', async () => {
    const res = await UNBOOK(send('POST', '/api/follow-ups/3/unbook', { reason: 'Patient travelling' }), ctx({ id: '3' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ order: VIEW, cancelledAppointmentId: 44 })
    expect(JSON.stringify(body)).not.toMatch(/RAW-/)
    expect(unbookFollowUp).toHaveBeenCalledWith(3, 'Patient travelling', expect.objectContaining({ role: 'frontdesk' }))
    expect(notifyFollowUpSafely).toHaveBeenCalledWith(expect.anything(), { kind: 'unbooked', followUpOrderId: 3, patientId: 'RD-0001', dueDate: '2026-10-21', appointmentStartsAt: null })
  })

  it.each([
    ['not_found', 404, 'Follow-up not found'],
    ['not_booked', 409, 'This follow-up has no booked appointment to cancel.'],
  ] as const)('maps %s to %i', async (error, status, message) => {
    vi.mocked(unbookFollowUp).mockResolvedValueOnce({ ok: false, error })
    const res = await UNBOOK(send('POST', '/api/follow-ups/3/unbook', { reason: 'x' }), ctx({ id: '3' }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('requires a reason', async () => {
    expect((await UNBOOK(send('POST', '/api/follow-ups/3/unbook', {}), ctx({ id: '3' }))).status).toBe(400)
    expect(unbookFollowUp).not.toHaveBeenCalled()
  })
})

describe('POST /api/follow-ups/[id]/contact-attempts', () => {
  it('contact attempt 409s on a closed follow-up and is 201 otherwise', async () => {
    vi.mocked(recordContactAttempt).mockResolvedValueOnce({ ok: false, error: 'closed' })
    const closed = await CONTACT(send('POST', '/api/follow-ups/3/contact-attempts', { channel: 'phone', outcome: 'no_answer' }), ctx({ id: '3' }))
    expect(closed.status).toBe(409)
    expect(await closed.json()).toEqual({ error: FOLLOW_UP_CLOSED_MESSAGE })

    const res = await CONTACT(send('POST', '/api/follow-ups/3/contact-attempts', { channel: 'phone', outcome: 'no_answer', note: 'busy tone' }), ctx({ id: '3' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      attempt: { id: 9, channel: 'phone', outcome: 'no_answer', note: 'busy tone', attemptedByName: 'Probe Desk', attemptedAt: '2026-10-20T04:00:00.000Z' },
    })
    expect(recordContactAttempt).toHaveBeenLastCalledWith(3, { channel: 'phone', outcome: 'no_answer', note: 'busy tone' }, expect.objectContaining({ role: 'frontdesk' }))
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('maps not_found to 404 and rejects an unknown channel', async () => {
    vi.mocked(recordContactAttempt).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await CONTACT(send('POST', '/api/follow-ups/3/contact-attempts', { channel: 'phone', outcome: 'no_answer' }), ctx({ id: '3' }))).status).toBe(404)
    const bad = await CONTACT(send('POST', '/api/follow-ups/3/contact-attempts', { channel: 'pigeon', outcome: 'no_answer' }), ctx({ id: '3' }))
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).not.toContain('pigeon')
    expect(recordContactAttempt).toHaveBeenCalledTimes(1)
  })
})

const FOLLOW_UP_CLOSED_MESSAGE = 'This follow-up is already completed or cancelled.'
