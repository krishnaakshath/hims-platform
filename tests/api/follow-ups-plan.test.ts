import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'pi'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'Probe User', userId: 7 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/follow-ups', () => ({
  createFollowUpOrder: vi.fn(),
  updateFollowUpPlan: vi.fn(),
  cancelFollowUpOrder: vi.fn(),
  getFollowUpView: vi.fn(),
}))
vi.mock('@/lib/follow-ups/notifier', () => ({ notifyFollowUpSafely: vi.fn(async () => undefined) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))

import { POST } from '@/app/api/follow-ups/route'
import { PATCH } from '@/app/api/follow-ups/[id]/route'
import { POST as CANCEL } from '@/app/api/follow-ups/[id]/cancel/route'
import { cancelFollowUpOrder, createFollowUpOrder, getFollowUpView, updateFollowUpPlan } from '@/lib/queries/follow-ups'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

const send = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (p: { id: string }) => ({ params: Promise.resolve(p) })

const VALID = { patientId: 'RD-0001', timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'BP review' }
const ORDER = { id: 3, patientId: 'RD-0001', dueDate: '2099-04-15', planNotes: 'RAW-NOTES', cancelReason: null }
const VIEW = { id: 3, patientId: 'RD-0001', dueDate: '2099-04-15', planNotes: 'view notes', appointment: null }
const DENIED = ['frontdesk', 'crc', 'billing', 'labs', 'pharmacy', 'coder', 'collector', 'rcm'] as const

beforeEach(() => {
  role = 'pi'
  signedIn = true
  vi.mocked(createFollowUpOrder).mockReset().mockResolvedValue({ ok: true, order: ORDER as never })
  vi.mocked(updateFollowUpPlan).mockReset().mockResolvedValue({ ok: true, order: ORDER as never, changedFields: ['reason'], bookingOutsideWindow: false })
  vi.mocked(cancelFollowUpOrder).mockReset().mockResolvedValue({ ok: true, order: ORDER as never, cancelledAppointmentId: null })
  vi.mocked(getFollowUpView).mockReset().mockResolvedValue(VIEW as never)
  vi.mocked(notifyFollowUpSafely).mockClear()
  vi.mocked(resolveDoctorQueueProvider).mockReset().mockResolvedValue({ id: 4, name: 'Dr. K' })
})
afterEach(() => vi.restoreAllMocks())

describe('role gate (inline, before parse)', () => {
  it.each(DENIED)('%s PATCH is 403 and never calls updateFollowUpPlan', async (r) => {
    role = r
    const res = await PATCH(send('PATCH', '/api/follow-ups/3', '{not json'), ctx({ id: '3' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(updateFollowUpPlan).not.toHaveBeenCalled()
  })

  it.each(DENIED)('%s POST and cancel are 403 before parse and never call a query', async (r) => {
    role = r
    const created = await POST(send('POST', '/api/follow-ups', '{not json'))
    const cancelled = await CANCEL(send('POST', '/api/follow-ups/3/cancel', '{not json'), ctx({ id: '3' }))
    for (const res of [created, cancelled]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(createFollowUpOrder).not.toHaveBeenCalled()
    expect(cancelFollowUpOrder).not.toHaveBeenCalled()
    expect(resolveDoctorQueueProvider).not.toHaveBeenCalled()
  })

  it('unauthenticated is 401', async () => {
    signedIn = false
    expect((await POST(send('POST', '/api/follow-ups', VALID))).status).toBe(401)
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', { reason: 'x' }), ctx({ id: '3' }))).status).toBe(401)
    expect((await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: 'x' }), ctx({ id: '3' }))).status).toBe(401)
  })

  it('unparseable JSON from an allowed role is 400 Invalid JSON', async () => {
    role = 'pi'
    const res = await POST(send('POST', '/api/follow-ups', '{not json'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', '{not json'), ctx({ id: '3' }))).status).toBe(400)
    expect((await CANCEL(send('POST', '/api/follow-ups/3/cancel', '{not json'), ctx({ id: '3' }))).status).toBe(400)
  })
})

describe('POST /api/follow-ups', () => {
  it('pi prescribes as self; a different prescribedByProviderId is 400', async () => {
    role = 'pi'
    const ok = await POST(send('POST', '/api/follow-ups', VALID))
    expect(ok.status).toBe(201)
    expect(createFollowUpOrder).toHaveBeenCalledWith(
      expect.objectContaining({ prescribedByProviderId: 4, source: 'manual', patientId: 'RD-0001', originatingEncounterId: null, originatingAdmissionId: null, departmentId: null, planNotes: null }),
      expect.objectContaining({ role: 'pi' }),
    )
    const res = await POST(send('POST', '/api/follow-ups', { ...VALID, prescribedByProviderId: 9 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Doctors always prescribe follow-ups as themselves.' })
    expect(createFollowUpOrder).toHaveBeenCalledTimes(1)
    // Naming themselves is fine.
    expect((await POST(send('POST', '/api/follow-ups', { ...VALID, prescribedByProviderId: 4 }))).status).toBe(201)
  })

  it('pi with no linked provider gets 403 and nothing is written', async () => {
    role = 'pi'
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValue(null)
    const res = await POST(send('POST', '/api/follow-ups', VALID))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Your login is not linked to a doctor profile, so you cannot prescribe a follow-up.' })
    expect(createFollowUpOrder).not.toHaveBeenCalled()
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('admin must name the prescriber', async () => {
    role = 'admin'
    const res = await POST(send('POST', '/api/follow-ups', VALID))
    expect(res.status).toBe(400)
    expect(createFollowUpOrder).not.toHaveBeenCalled()
    expect((await POST(send('POST', '/api/follow-ups', { ...VALID, prescribedByProviderId: 9, originatingEncounterId: 12 }))).status).toBe(201)
    expect(createFollowUpOrder).toHaveBeenCalledWith(expect.objectContaining({ prescribedByProviderId: 9, source: 'encounter', originatingEncounterId: 12 }), expect.anything())
    expect(resolveDoctorQueueProvider).not.toHaveBeenCalled()
  })

  it('201 returns the role view (not the raw row) and notifies planned after the write', async () => {
    const res = await POST(send('POST', '/api/follow-ups', VALID))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ order: VIEW })
    expect(getFollowUpView).toHaveBeenCalledWith(3, 'pi')
    expect(notifyFollowUpSafely).toHaveBeenCalledWith(expect.objectContaining({ role: 'pi' }), { kind: 'planned', followUpOrderId: 3, patientId: 'RD-0001', dueDate: '2099-04-15', appointmentStartsAt: null })
    expect(vi.mocked(createFollowUpOrder).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(notifyFollowUpSafely).mock.invocationCallOrder[0])
  })

  it('maps due_date_invalid to 400 with the message and notifies only on success', async () => {
    vi.mocked(createFollowUpOrder).mockResolvedValueOnce({ ok: false, error: 'due_date_invalid', message: 'The follow-up date cannot be in the past.' })
    const res = await POST(send('POST', '/api/follow-ups', VALID))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The follow-up date cannot be in the past.' })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it.each([
    ['patient_not_found', 404],
    ['provider_not_found', 404],
    ['encounter_not_found', 404],
    ['encounter_mismatch', 409],
  ] as const)('maps %s to %i', async (error, status) => {
    vi.mocked(createFollowUpOrder).mockResolvedValueOnce({ ok: false, error })
    const res = await POST(send('POST', '/api/follow-ups', VALID))
    expect(res.status).toBe(status)
    if (error === 'encounter_mismatch') expect(await res.json()).toEqual({ error: 'That visit belongs to a different patient.' })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('department_not_found and a foreign-key violation (23503) are a fixed 400 (M6)', async () => {
    role = 'admin'
    vi.mocked(createFollowUpOrder).mockResolvedValueOnce({ ok: false, error: 'department_not_found' })
    const missing = await POST(send('POST', '/api/follow-ups', { ...VALID, prescribedByProviderId: 9, departmentId: 77 }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'Department not found or inactive' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createFollowUpOrder).mockRejectedValueOnce(Object.assign(new Error('fk SECRET'), { code: '23503', constraint: 'follow_up_orders_department_id_fk' }))
    const fk = await POST(send('POST', '/api/follow-ups', { ...VALID, prescribedByProviderId: 9, departmentId: 77 }))
    expect(fk.status).toBe(400)
    expect(await fk.json()).toEqual({ error: 'A linked record does not exist.' })
    vi.mocked(updateFollowUpPlan).mockResolvedValueOnce({ ok: false, error: 'department_not_found' })
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', { departmentId: 77 }), ctx({ id: '3' }))).status).toBe(400)
    vi.mocked(updateFollowUpPlan).mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }))
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', { departmentId: 77 }), ctx({ id: '3' }))).status).toBe(400)
  })

  it('a schema error is a fixed 400 that does not echo input', async () => {
    const res = await POST(send('POST', '/api/follow-ups', { ...VALID, sneaky: 'ECHO-ME' }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('ECHO-ME')
    expect(JSON.stringify(await (await POST(send('POST', '/api/follow-ups', { ...VALID, reason: '' }))).json())).not.toContain('sneaky')
    expect(createFollowUpOrder).not.toHaveBeenCalled()
  })

  it('a deadlock is a 409 asking to try again; other errors are a generic 500 logging only the code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createFollowUpOrder).mockRejectedValueOnce(Object.assign(new Error('deadlock SECRET'), { code: '40P01' }))
    const retry = await POST(send('POST', '/api/follow-ups', VALID))
    expect(retry.status).toBe(409)
    expect((await retry.json()).error).toMatch(/try again/)
    vi.mocked(createFollowUpOrder).mockRejectedValueOnce(Object.assign(new Error('boom SECRET'), { code: '23514', constraint: 'ck_x' }))
    const failed = await POST(send('POST', '/api/follow-ups', VALID))
    expect(failed.status).toBe(500)
    expect(JSON.stringify(await failed.json())).not.toContain('SECRET')
    const logged = spy.mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('23514')
    expect(logged).not.toContain('SECRET')
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/follow-ups/[id]', () => {
  it('a pi may not reassign the prescriber; admin may', async () => {
    role = 'pi'
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', { prescribedByProviderId: 9 }), ctx({ id: '3' }))).status).toBe(400)
    expect(updateFollowUpPlan).not.toHaveBeenCalled()
    role = 'admin'
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', { prescribedByProviderId: 9 }), ctx({ id: '3' }))).status).toBe(200)
    expect(updateFollowUpPlan).toHaveBeenCalledWith(3, { prescribedByProviderId: 9 }, expect.objectContaining({ role: 'admin' }), null)
  })

  it('a pi with no linked provider gets 403 before any write', async () => {
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValue(null)
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', { reason: 'x' }), ctx({ id: '3' }))).status).toBe(403)
    expect(updateFollowUpPlan).not.toHaveBeenCalled()
  })

  it('a pi acts as their own provider; another doctor\'s follow-up is 403 Forbidden (I3)', async () => {
    await PATCH(send('PATCH', '/api/follow-ups/3', { reason: 'x' }), ctx({ id: '3' }))
    expect(updateFollowUpPlan).toHaveBeenLastCalledWith(3, { reason: 'x' }, expect.objectContaining({ role: 'pi' }), 4)
    vi.mocked(updateFollowUpPlan).mockResolvedValueOnce({ ok: false, error: 'not_owner' })
    const res = await PATCH(send('PATCH', '/api/follow-ups/3', { reason: 'x' }), ctx({ id: '3' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('PATCH reports bookingOutsideWindow and notifies plan_changed only when timing changed', async () => {
    const quiet = await PATCH(send('PATCH', '/api/follow-ups/3', { reason: 'new reason' }), ctx({ id: '3' }))
    expect(quiet.status).toBe(200)
    expect(await quiet.json()).toEqual({ order: VIEW, bookingOutsideWindow: false })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()

    vi.mocked(updateFollowUpPlan).mockResolvedValueOnce({ ok: true, order: ORDER as never, changedFields: ['dueDate', 'timing'], bookingOutsideWindow: true })
    const starts = '2099-04-20T04:30:00.000Z'
    vi.mocked(getFollowUpView).mockResolvedValueOnce({ ...VIEW, appointment: { id: 8, status: 'scheduled', startsAt: new Date(starts) } } as never)
    const moved = await PATCH(send('PATCH', '/api/follow-ups/3', { timing: { kind: 'date', dueDate: '2099-05-01' } }), ctx({ id: '3' }))
    expect(moved.status).toBe(200)
    expect((await moved.json()).bookingOutsideWindow).toBe(true)
    expect(notifyFollowUpSafely).toHaveBeenCalledWith(expect.anything(), { kind: 'plan_changed', followUpOrderId: 3, patientId: 'RD-0001', dueDate: '2099-04-15', appointmentStartsAt: new Date(starts) })
  })

  it.each([
    ['not_found', 404, 'Follow-up not found'],
    ['not_editable', 409, 'This follow-up is already completed or cancelled.'],
    ['provider_not_found', 404, 'Doctor not found or inactive'],
  ] as const)('maps %s to %i', async (error, status, message) => {
    role = 'admin'
    vi.mocked(updateFollowUpPlan).mockResolvedValueOnce({ ok: false, error })
    const res = await PATCH(send('PATCH', '/api/follow-ups/3', { reason: 'x' }), ctx({ id: '3' }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('maps due_date_invalid to 400 with the message', async () => {
    vi.mocked(updateFollowUpPlan).mockResolvedValueOnce({ ok: false, error: 'due_date_invalid', message: 'The follow-up date must be within 2 years.' })
    const res = await PATCH(send('PATCH', '/api/follow-ups/3', { timing: { kind: 'date', dueDate: '2199-01-01' } }), ctx({ id: '3' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The follow-up date must be within 2 years.' })
  })

  it('rejects an empty patch and a bad id with 400 and no query', async () => {
    expect((await PATCH(send('PATCH', '/api/follow-ups/3', {}), ctx({ id: '3' }))).status).toBe(400)
    for (const id of ['0', 'abc', '-1', '2147483648', '1.5']) {
      expect((await PATCH(send('PATCH', `/api/follow-ups/${id}`, { reason: 'x' }), ctx({ id }))).status).toBe(400)
    }
    expect(updateFollowUpPlan).not.toHaveBeenCalled()
  })
})

describe('POST /api/follow-ups/[id]/cancel', () => {
  it('200 returns the view and cancelled appointment id, then notifies cancelled', async () => {
    vi.mocked(cancelFollowUpOrder).mockResolvedValueOnce({ ok: true, order: ORDER as never, cancelledAppointmentId: 8 })
    const res = await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: 'Patient moved away' }), ctx({ id: '3' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ order: VIEW, cancelledAppointmentId: 8 })
    expect(cancelFollowUpOrder).toHaveBeenCalledWith(3, 'Patient moved away', expect.objectContaining({ role: 'pi' }), 4)
    expect(notifyFollowUpSafely).toHaveBeenCalledWith(expect.anything(), { kind: 'cancelled', followUpOrderId: 3, patientId: 'RD-0001', dueDate: '2099-04-15', appointmentStartsAt: null })
  })

  it.each([['not_found', 404], ['not_cancellable', 409]] as const)('maps %s to %i without notifying', async (error, status) => {
    vi.mocked(cancelFollowUpOrder).mockResolvedValueOnce({ ok: false, error })
    expect((await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: 'x' }), ctx({ id: '3' }))).status).toBe(status)
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('another doctor\'s follow-up is 403 Forbidden for a pi (I3)', async () => {
    vi.mocked(cancelFollowUpOrder).mockResolvedValueOnce({ ok: false, error: 'not_owner' })
    const res = await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: 'x' }), ctx({ id: '3' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
    role = 'admin'
    await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: 'x' }), ctx({ id: '3' }))
    expect(cancelFollowUpOrder).toHaveBeenLastCalledWith(3, 'x', expect.objectContaining({ role: 'admin' }), null)
  })

  it('requires a reason and a pi linked to a doctor profile', async () => {
    expect((await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: '   ' }), ctx({ id: '3' }))).status).toBe(400)
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValue(null)
    expect((await CANCEL(send('POST', '/api/follow-ups/3/cancel', { reason: 'x' }), ctx({ id: '3' }))).status).toBe(403)
    expect(cancelFollowUpOrder).not.toHaveBeenCalled()
  })
})
