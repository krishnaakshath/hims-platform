import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Taylor Nguyen', userId: null })) }))
vi.mock('@/lib/queries/encounters', () => ({ checkInVisit: vi.fn() }))
vi.mock('@/lib/queries/admissions', () => ({ getActiveAdmissionForPatient: vi.fn(async () => null) }))
vi.mock('@/lib/queries/rooms', () => ({ assignRoomToPatient: vi.fn(async () => true) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }))
vi.mock('@/db/client', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: async () => [{ id: 1 }] }) }) }),
}))

import { POST } from '@/app/api/front-desk/check-in/route'
import { checkInVisit } from '@/lib/queries/encounters'
import { getActiveAdmissionForPatient } from '@/lib/queries/admissions'
import { logAudit } from '@/lib/audit'
import { RETRY_MESSAGE } from '@/lib/db-errors'

const valid = { patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'routine', reason: 'Review' }
const req = (body: unknown) => new Request('http://localhost/api/front-desk/check-in', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never

beforeEach(() => {
  role = 'frontdesk'
  vi.mocked(checkInVisit).mockReset()
  vi.mocked(getActiveAdmissionForPatient).mockResolvedValue(null)
})

describe('POST /api/front-desk/check-in (encounter)', () => {
  it('passes appointmentId through and returns encounterId + opdToken', async () => {
    vi.mocked(checkInVisit).mockResolvedValue({ ok: true, assignment: { id: 5, roomId: null, status: 'scheduled' } as never, encounter: { id: 9, opdToken: 4 } as never, admissionId: null, completedFollowUpOrderId: 3 })
    const res = await POST(req({ ...valid, appointmentId: 77 }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: 5, roomId: null, status: 'scheduled', encounterId: 9, opdToken: 4 })
    expect(checkInVisit).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 77, createAdmission: false, roomId: null }), expect.objectContaining({ name: 'Taylor Nguyen' }))
    // The audit row is written inside the transaction now, not by the route.
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('creates the admission only for an inpatient with no active admission', async () => {
    vi.mocked(checkInVisit).mockResolvedValue({ ok: true, assignment: { id: 5 } as never, encounter: { id: 9, opdToken: 1 } as never, admissionId: 2, completedFollowUpOrderId: null })
    await POST(req({ ...valid, visitType: 'inpatient' }))
    expect(checkInVisit).toHaveBeenLastCalledWith(expect.objectContaining({ createAdmission: true, appointmentId: null }), expect.anything())
    vi.mocked(getActiveAdmissionForPatient).mockResolvedValue({ id: 1 } as never)
    await POST(req({ ...valid, visitType: 'inpatient' }))
    expect(checkInVisit).toHaveBeenLastCalledWith(expect.objectContaining({ createAdmission: false }), expect.anything())
  })

  it.each([
    ['appointment_not_found', 404, 'Appointment not found'],
    ['appointment_mismatch', 409, 'That appointment is for a different patient or doctor.'],
    ['appointment_not_scheduled', 409, 'That appointment is not in a bookable state.'],
    ['appointment_not_today', 409, 'That appointment is not today.'],
    ['appointment_already_checked_in', 409, 'This appointment has already been checked in.'],
  ] as const)('maps %s to %i', async (error, status, message) => {
    vi.mocked(checkInVisit).mockResolvedValue({ ok: false, error })
    const res = await POST(req({ ...valid, appointmentId: 77 }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
  })

  it('409s an appointment on another IST date', async () => {
    vi.mocked(checkInVisit).mockResolvedValue({ ok: false, error: 'appointment_not_today' })
    expect((await POST(req({ ...valid, appointmentId: 77 }))).status).toBe(409)
  })

  it('rejects appointmentId on an inpatient check-in before any write', async () => {
    const res = await POST(req({ ...valid, visitType: 'inpatient', appointmentId: 77 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'appointmentId is only valid for an outpatient check-in' })
    expect(checkInVisit).not.toHaveBeenCalled()
  })

  it('400s a body that is not JSON', async () => {
    const res = await POST(req('{not json'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('rejects a non-positive appointmentId', async () => {
    expect((await POST(req({ ...valid, appointmentId: 0 }))).status).toBe(400)
    expect(checkInVisit).not.toHaveBeenCalled()
  })

  it('403s a denied role before reading the body', async () => {
    role = 'pi'
    const res = await POST(req('{not json'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('a failed transaction is a generic 500 that logs only the pg code and constraint', async () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint (RD-0001 Review)'), { code: '23505', constraint: 'encounters_date_token_unique' })
    vi.mocked(checkInVisit).mockRejectedValue(err)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req(valid))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Could not check in the patient' })
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = spy.mock.calls.flat().join(' ')
    expect(logged).toContain('23505')
    expect(logged).toContain('encounters_date_token_unique')
    expect(logged).not.toContain('RD-0001')
    expect(logged).not.toContain('Review')
    spy.mockRestore()
  })

  it.each(['40P01', '40001'])('a %s (deadlock / serialization failure) is a 409 asking to try again', async (code) => {
    vi.mocked(checkInVisit).mockRejectedValue(Object.assign(new Error('deadlock detected'), { code }))
    const res = await POST(req(valid))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: RETRY_MESSAGE })
  })
})
