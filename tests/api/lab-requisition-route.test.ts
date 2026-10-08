import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'pi'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'Dr. Probe', userId: 7 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/lab-requisitions', () => ({ createLabRequisition: vi.fn() }))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn() }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 4, name: 'Dr. Probe' }]) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 4, name: 'Dr. Probe' })) }))
vi.mock('@/lib/brand', () => ({ brand: { name: 'Probe Hospital' } }))

import { POST } from '@/app/api/patients/[anonId]/lab-orders/route'
import { createLabRequisition } from '@/lib/queries/lab-requisitions'
import { notifyPatientSafely } from '@/lib/queries/notifications'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

const ctx = { params: Promise.resolve({ anonId: 'RD-0001' }) }
const send = (body: unknown) =>
  new NextRequest('http://localhost/api/patients/RD-0001/lab-orders', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const LINE = { orderId: 30, labTestId: 1, quotedPricePaise: 45000, quoteStatus: 'quoted' as const }

beforeEach(() => {
  role = 'pi'
  signedIn = true
  vi.mocked(createLabRequisition).mockReset().mockResolvedValue({ ok: true, requisition: { id: 12 } as never, lines: [LINE], patientIsLocal: false, includesLabTest: true })
  vi.mocked(notifyPatientSafely).mockReset().mockResolvedValue('logged')
  vi.mocked(resolveDoctorQueueProvider).mockClear()
})

describe('POST /api/patients/[anonId]/lab-orders (requisition)', () => {
  it('notifies only local patients, with a requisition dedupe key', async () => {
    vi.mocked(createLabRequisition).mockResolvedValue({ ok: true, requisition: { id: 12 } as never, lines: [], patientIsLocal: true, includesLabTest: true })
    const res = await POST(send({ labTestIds: [1] }), ctx)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ requisitionId: 12, lines: [], patientIsLocal: true, notification: 'logged' })
    expect(notifyPatientSafely).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      patientId: 'RD-0001',
      templateKey: 'lab_tests_ordered',
      vars: { hospitalName: 'Probe Hospital' },
      related: { type: 'lab_requisition', id: 12 },
      dedupeKey: 'lab_tests_ordered:requisition=12',
    }))
    // Called only after the requisition was written.
    expect(vi.mocked(createLabRequisition).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(notifyPatientSafely).mock.invocationCallOrder[0])
  })

  it('a non-local patient gets no notice', async () => {
    const res = await POST(send({ labTestIds: [1] }), ctx)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ requisitionId: 12, lines: [LINE], patientIsLocal: false, notification: null })
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  // SP5 Task 8 ruling: imaging stays orderable, but only a lab test triggers the home-collection notice.
  it('an imaging-only order for a local patient sends no notice', async () => {
    vi.mocked(createLabRequisition).mockResolvedValue({ ok: true, requisition: { id: 12 } as never, lines: [], patientIsLocal: true, includesLabTest: false })
    const res = await POST(send({ labTestIds: [1] }), ctx)
    expect(res.status).toBe(201)
    expect((await res.json()).notification).toBeNull()
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('a notifier failure still returns 201', async () => {
    vi.mocked(createLabRequisition).mockResolvedValue({ ok: true, requisition: { id: 12 } as never, lines: [], patientIsLocal: true, includesLabTest: true })
    vi.mocked(notifyPatientSafely).mockResolvedValue('error')
    const res = await POST(send({ labTestIds: [1] }), ctx)
    expect(res.status).toBe(201)
    expect((await res.json()).notification).toBe('error')
  })

  it('keeps accepting the legacy { labTestId } body', async () => {
    expect((await POST(send({ labTestId: 5 }), ctx)).status).toBe(201)
    expect(createLabRequisition).toHaveBeenCalledWith(
      { labTestIds: [5], followUp: null, originatingEncounterId: null, patientId: 'RD-0001', orderedByProviderId: 4 },
      expect.objectContaining({ role: 'pi' }),
    )
  })

  it('passes the follow-up request and encounter through', async () => {
    await POST(send({ labTestIds: [1, 3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review' }, originatingEncounterId: 9 }), ctx)
    expect(createLabRequisition).toHaveBeenCalledWith(
      { labTestIds: [1, 3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review' }, originatingEncounterId: 9, patientId: 'RD-0001', orderedByProviderId: 4 },
      expect.anything(),
    )
  })

  it.each(['labs', 'crc', 'frontdesk', 'billing', 'pharmacy', 'collector'] as const)('%s is denied before parse', async (r) => {
    role = r
    const res = await POST(send('{not json'), ctx)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(createLabRequisition).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    signedIn = false
    expect((await POST(send({ labTestIds: [1] }), ctx)).status).toBe(401)
  })

  it('400s bad JSON and invalid bodies before any query', async () => {
    const bad = await POST(send('{not json'), ctx)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Invalid JSON' })
    for (const body of [{}, { labTestIds: [] }, { labTestIds: [1, 1] }, { labTestIds: [1], extra: true }, { labTestId: 1, followUp: null }]) {
      expect((await POST(send(body), ctx)).status).toBe(400)
    }
    expect(createLabRequisition).not.toHaveBeenCalled()
    expect(resolveDoctorQueueProvider).not.toHaveBeenCalled()
  })

  it('maps the query errors', async () => {
    for (const error of ['patient_not_found', 'test_not_found', 'encounter_not_found'] as const) {
      vi.mocked(createLabRequisition).mockResolvedValueOnce({ ok: false, error })
      expect((await POST(send({ labTestIds: [1] }), ctx)).status).toBe(404)
    }
    vi.mocked(createLabRequisition).mockResolvedValueOnce({ ok: false, error: 'encounter_mismatch' })
    const res = await POST(send({ labTestIds: [1], originatingEncounterId: 2 }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'That visit belongs to a different patient.' })
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('a pi with no provider identity is refused; a deadlock is a retryable 409', async () => {
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValueOnce(null)
    expect((await POST(send({ labTestIds: [1] }), ctx)).status).toBe(403)
    expect(createLabRequisition).not.toHaveBeenCalled()

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createLabRequisition).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
    const res = await POST(send({ labTestIds: [1] }), ctx)
    expect(res.status).toBe(409)
    vi.mocked(createLabRequisition).mockRejectedValueOnce(new Error('boom RD-0001'))
    const res2 = await POST(send({ labTestIds: [1] }), ctx)
    expect(res2.status).toBe(500)
    for (const call of err.mock.calls) expect(call.map(String).join(' ')).not.toContain('RD-0001')
    err.mockRestore()
  })
})
