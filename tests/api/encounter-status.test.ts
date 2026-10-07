import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: null })) }))
vi.mock('@/lib/queries/encounters', () => ({ transitionEncounter: vi.fn() }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))

import { POST } from '@/app/api/encounters/[id]/status/route'
import { transitionEncounter } from '@/lib/queries/encounters'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { RETRY_MESSAGE } from '@/lib/db-errors'

const send = (body: unknown) => new NextRequest('http://localhost/api/encounters/3/status', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
// A full row: the route must answer with an explicit projection (M7), never the row.
const ENCOUNTER = {
  id: 3, patientId: 'RD-0001', encounterType: 'opd', visitType: 'new', status: 'completed', encounterDate: '2026-10-07', opdToken: 4,
  departmentId: 2, providerId: 4, appointmentId: null, admissionId: null, doctorAssignmentId: 11,
  checkedInByName: 'Desk A', checkedInAt: new Date('2026-10-07T04:00:00Z'), statusChangedAt: new Date('2026-10-07T05:00:00Z'),
  statusChangedByName: 'Dr K', completedAt: new Date('2026-10-07T05:00:00Z'), cancelReason: 'FREE-TEXT-SECRET',
}
const PROJECTED = {
  id: 3, patientId: 'RD-0001', encounterType: 'opd', visitType: 'new', status: 'completed', encounterDate: '2026-10-07', opdToken: 4,
  departmentId: 2, providerId: 4, appointmentId: null, admissionId: null,
  checkedInAt: '2026-10-07T04:00:00.000Z', statusChangedAt: '2026-10-07T05:00:00.000Z', statusChangedByName: 'Dr K', completedAt: '2026-10-07T05:00:00.000Z',
}

beforeEach(() => {
  role = 'frontdesk'
  vi.mocked(transitionEncounter).mockReset()
  vi.mocked(transitionEncounter).mockResolvedValue({ ok: true, encounter: ENCOUNTER as never })
  vi.mocked(resolveDoctorQueueProvider).mockReset().mockResolvedValue({ id: 4, name: 'Dr. K' })
})

describe('POST /api/encounters/[id]/status', () => {
  it('frontdesk may cancel but not complete', async () => {
    role = 'frontdesk'
    expect((await POST(send({ to: 'completed' }), ctx('3'))).status).toBe(403)
    expect(transitionEncounter).not.toHaveBeenCalled()
    const res = await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ encounter: PROJECTED })
    expect(transitionEncounter).toHaveBeenCalledWith(3, 'cancelled', expect.objectContaining({ role: 'frontdesk' }), { cancelReason: 'left', actingProviderId: null })
  })

  it('pi may start and complete a consultation but not cancel', async () => {
    role = 'pi'
    expect((await POST(send({ to: 'in_consultation' }), ctx('3'))).status).toBe(200)
    expect((await POST(send({ to: 'completed' }), ctx('3'))).status).toBe(200)
    const denied = await POST(send({ to: 'cancelled', cancelReason: 'x' }), ctx('3'))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
  })

  it('answers with an explicit projection: no cancel reason, no assignment id, no check-in clerk (M7)', async () => {
    role = 'admin'
    const body = await (await POST(send({ to: 'completed' }), ctx('3'))).json()
    expect(body).toEqual({ encounter: PROJECTED })
    expect(JSON.stringify(body)).not.toContain('FREE-TEXT-SECRET')
  })

  it('a pi acts as their own provider: another doctor\'s visit is 403, an unlinked pi is 403 before any write (I3)', async () => {
    role = 'pi'
    await POST(send({ to: 'in_consultation' }), ctx('3'))
    expect(transitionEncounter).toHaveBeenLastCalledWith(3, 'in_consultation', expect.objectContaining({ role: 'pi' }), { cancelReason: undefined, actingProviderId: 4 })
    vi.mocked(transitionEncounter).mockResolvedValueOnce({ ok: false, error: 'not_owner' })
    const notMine = await POST(send({ to: 'completed' }), ctx('3'))
    expect(notMine.status).toBe(403)
    expect(await notMine.json()).toEqual({ error: 'Forbidden' })
    vi.mocked(transitionEncounter).mockClear()
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValueOnce(null)
    const unlinked = await POST(send({ to: 'completed' }), ctx('3'))
    expect(unlinked.status).toBe(403)
    expect(await unlinked.json()).toEqual({ error: 'Forbidden' })
    expect(transitionEncounter).not.toHaveBeenCalled()
  })

  it('admin is not bound to a provider', async () => {
    role = 'admin'
    await POST(send({ to: 'completed' }), ctx('3'))
    expect(transitionEncounter).toHaveBeenLastCalledWith(3, 'completed', expect.objectContaining({ role: 'admin' }), { cancelReason: undefined, actingProviderId: null })
    expect(resolveDoctorQueueProvider).not.toHaveBeenCalled()
  })

  it('maps admission_active to 409 with a fixed message (M8)', async () => {
    vi.mocked(transitionEncounter).mockResolvedValueOnce({ ok: false, error: 'admission_active' })
    const res = await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This patient is still admitted. Discharge them before cancelling the visit.' })
  })

  it('maps invalid_transition to 409 and not_found to 404', async () => {
    role = 'admin'
    vi.mocked(transitionEncounter).mockResolvedValueOnce({ ok: false, error: 'invalid_transition' })
    const conflict = await POST(send({ to: 'completed' }), ctx('3'))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'This visit can no longer change to that status.' })
    vi.mocked(transitionEncounter).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    const missing = await POST(send({ to: 'completed' }), ctx('3'))
    expect(missing.status).toBe(404)
  })

  it('403s a role outside the gate before parsing the body', async () => {
    for (const r of ['billing', 'labs', 'pharmacy', 'collector']) {
      role = r
      const res = await POST(send('{not json'), ctx('3'))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
  })

  it('400s bad JSON, a bad payload and a bad id without echoing input', async () => {
    const bad = await POST(send('{not json'), ctx('3'))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Invalid JSON' })
    const noReason = await POST(send({ to: 'cancelled' }), ctx('3'))
    expect(noReason.status).toBe(400)
    const unknown = await POST(send({ to: 'teleported-SECRET' }), ctx('3'))
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).not.toContain('SECRET')
    for (const id of ['abc', '0', '-1', '1.5', '99999999999']) {
      const res = await POST(send({ to: 'cancelled', cancelReason: 'x' }), ctx(id))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid encounter id' })
    }
    expect(transitionEncounter).not.toHaveBeenCalled()
  })

  it.each(['40P01', '40001'])('a %s is a 409 asking to try again', async (code) => {
    vi.mocked(transitionEncounter).mockRejectedValueOnce(Object.assign(new Error('boom'), { code }))
    const res = await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: RETRY_MESSAGE })
  })

  it('a thrown error is a generic 500', async () => {
    vi.mocked(transitionEncounter).mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23503' }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not update the visit' })
    expect(spy.mock.calls.flat().join(' ')).toContain('23503')
    expect(spy.mock.calls.flat().join(' ')).not.toContain('left')
    spy.mockRestore()
  })
})
