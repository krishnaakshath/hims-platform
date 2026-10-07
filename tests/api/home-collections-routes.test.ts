// SP5 Task 11: the home-collection routes (context, availability, book, reschedule, cancel,
// collector), with the session, the audit log, the booking queries and the notifier mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let role: Role = 'frontdesk'
let userId: number | null = 41
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role, name: 'TEST_SP5_probe', userId })),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/home-collections', () => ({
  getHomeCollectionContext: vi.fn(),
  listWindowAvailability: vi.fn(),
  bookHomeCollection: vi.fn(),
  rescheduleHomeCollection: vi.fn(),
  cancelHomeCollection: vi.fn(),
  assignCollector: vi.fn(),
}))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))

import { POST as BOOK } from '@/app/api/home-collections/route'
import { GET as CONTEXT } from '@/app/api/home-collections/context/route'
import { GET as AVAILABILITY } from '@/app/api/home-collections/availability/route'
import { PATCH as RESCHEDULE } from '@/app/api/home-collections/[id]/route'
import { POST as CANCEL } from '@/app/api/home-collections/[id]/cancel/route'
import { PUT as COLLECTOR } from '@/app/api/home-collections/[id]/collector/route'
import {
  assignCollector, bookHomeCollection, cancelHomeCollection, getHomeCollectionContext, listWindowAvailability, rescheduleHomeCollection,
} from '@/lib/queries/home-collections'
import { notifyPatientSafely } from '@/lib/queries/notifications'
import { logAudit } from '@/lib/audit'
import { brand } from '@/lib/brand'

const send = (method: string, body?: unknown, path = '/api/home-collections') =>
  new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
const get = (path: string) => new NextRequest(`http://localhost${path}`)
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })

const BOOK_BODY = {
  patientId: 'RD-0001',
  labOrderIds: [11, 12],
  visitDate: '2099-07-02',
  windowId: 3,
  address: { line1: 'SECRETLINE 1', city: 'Pune', stateCode: 'IN-MH', pinCode: '411001' },
  contactPhone: '9845013210',
}
const VISIT = { id: 77, patientId: 'RD-0001', visitDate: '2099-07-02', windowLabel: 'Morning 7-9', rescheduleCount: 0, status: 'booked' }

const ALL_MOCKS = [getHomeCollectionContext, listWindowAvailability, bookHomeCollection, rescheduleHomeCollection, cancelHomeCollection, assignCollector, notifyPatientSafely, logAudit]
beforeEach(() => {
  role = 'frontdesk'
  userId = 41
  for (const fn of ALL_MOCKS) vi.mocked(fn).mockClear()
  vi.mocked(notifyPatientSafely).mockResolvedValue('logged')
})

describe('POST /api/home-collections (book)', () => {
  it.each(['pi', 'crc', 'billing', 'pharmacy', 'collector'] as const)('%s cannot book (403 before parse)', async (r) => {
    role = r
    const res = await BOOK(send('POST', '{not json'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(bookHomeCollection).not.toHaveBeenCalled()
  })

  it('books, returns 201 with sample IDs by order, then notifies with the visit dedupe key', async () => {
    vi.mocked(bookHomeCollection).mockResolvedValue({ ok: true, visit: VISIT as never, sampleIds: new Map([[11, 'L990701000014'], [12, 'L990701000029']]) })
    const res = await BOOK(send('POST', BOOK_BODY))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sampleIds).toEqual({ 11: 'L990701000014', 12: 'L990701000029' })
    expect(body.visit.id).toBe(77)
    expect(bookHomeCollection).toHaveBeenCalledWith({ ...BOOK_BODY, contactPhone: '+919845013210' }, expect.objectContaining({ role: 'frontdesk' }))
    expect(notifyPatientSafely).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), {
      patientId: 'RD-0001',
      templateKey: 'home_collection_booked',
      vars: { hospitalName: brand.name, visitDate: '2099-07-02', windowLabel: 'Morning 7-9' },
      related: { type: 'home_collection_visit', id: 77 },
      dedupeKey: 'home_collection_booked:visit=77',
    })
    expect(vi.mocked(bookHomeCollection).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(notifyPatientSafely).mock.invocationCallOrder[0])
  })

  it.each([
    ['slot_full', 409, 'That collection window is full. Pick another window.'],
    ['not_in_service_area', 409, 'That address is outside the home-collection service area. The patient can visit the lab instead.'],
    ['window_closed', 409, 'That collection window has already started or is too close to book.'],
    ['order_not_bookable', 409, 'One or more tests are already booked, collected, cancelled, or cannot be collected at home.'],
    ['already_booked', 409, 'This patient already has a home collection in that window.'],
    ['window_not_found', 404, 'Collection window not found'],
    ['patient_not_found', 404, 'Patient not found'],
  ] as const)('maps %s to %i', async (error, status, message) => {
    vi.mocked(bookHomeCollection).mockResolvedValue({ ok: false, error })
    const res = await BOOK(send('POST', BOOK_BODY))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('maps invalid_date to 400 with its message', async () => {
    vi.mocked(bookHomeCollection).mockResolvedValue({ ok: false, error: 'invalid_date', message: 'Pick today or a later date.' })
    const res = await BOOK(send('POST', BOOK_BODY))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Pick today or a later date.' })
  })

  it('400s bad JSON and an invalid body before any query, never echoing input', async () => {
    expect((await BOOK(send('POST', '{not json'))).status).toBe(400)
    const bad = await BOOK(send('POST', { ...BOOK_BODY, address: { ...BOOK_BODY.address, stateCode: 'SECRET-XX' } }))
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).not.toContain('SECRET')
    const unknownKey = await BOOK(send('POST', { ...BOOK_BODY, SECRETKEY: 1 }))
    expect(unknownKey.status).toBe(400)
    expect(JSON.stringify(await unknownKey.json())).not.toContain('SECRET')
    const badPin = await BOOK(send('POST', { ...BOOK_BODY, address: { ...BOOK_BODY.address, pinCode: '12345' } }))
    expect(await badPin.json()).toEqual({ error: 'Enter a valid 6-digit PIN code' })
    expect(bookHomeCollection).not.toHaveBeenCalled()
  })

  it('a deadlock is a 409 retry and sends no notice', async () => {
    vi.mocked(bookHomeCollection).mockRejectedValue(deadlock())
    const res = await BOOK(send('POST', BOOK_BODY))
    expect(res.status).toBe(409)
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('a notifier error still returns 201', async () => {
    vi.mocked(bookHomeCollection).mockResolvedValue({ ok: true, visit: VISIT as never, sampleIds: new Map() })
    vi.mocked(notifyPatientSafely).mockResolvedValue('error')
    expect((await BOOK(send('POST', BOOK_BODY))).status).toBe(201)
  })
})

describe('GET /api/home-collections/context and /availability', () => {
  it('context: missing patient is 400, unknown is 404, found is 200 and audited', async () => {
    expect((await CONTEXT(get('/api/home-collections/context'))).status).toBe(400)
    vi.mocked(getHomeCollectionContext).mockResolvedValue(null)
    const nf = await CONTEXT(get('/api/home-collections/context?patient=UH-1'))
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'Patient not found' })
    expect(logAudit).not.toHaveBeenCalled()
    const context = { patient: { id: 'RD-0001' }, isLocal: true, bookableOrders: [], bookableOrderCount: 0, activeVisits: [] }
    vi.mocked(getHomeCollectionContext).mockResolvedValue(context as never)
    const ok = await CONTEXT(get('/api/home-collections/context?patient=UH-1'))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(context)
    expect(getHomeCollectionContext).toHaveBeenCalledWith('UH-1')
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), 'viewed home collection booking context', 'RD-0001')
  })

  it('availability: an invalid date is 400; a valid one returns the windows', async () => {
    expect((await AVAILABILITY(get('/api/home-collections/availability?date=2099-02-30'))).status).toBe(400)
    expect((await AVAILABILITY(get('/api/home-collections/availability'))).status).toBe(400)
    vi.mocked(listWindowAvailability).mockResolvedValue([{ windowId: 3, label: 'M', startTime: '07:00', endTime: '09:00', capacity: 4, booked: 1, remaining: 3, closed: false }])
    const res = await AVAILABILITY(get('/api/home-collections/availability?date=2099-07-02'))
    expect(res.status).toBe(200)
    expect((await res.json())[0].remaining).toBe(3)
    expect(listWindowAvailability).toHaveBeenCalledWith('2099-07-02')
  })

  it.each(['pi', 'crc', 'collector'] as const)('%s cannot read the booking context or availability', async (r) => {
    role = r
    expect((await CONTEXT(get('/api/home-collections/context?patient=UH-1'))).status).toBe(403)
    expect((await AVAILABILITY(get('/api/home-collections/availability?date=2099-07-02'))).status).toBe(403)
    expect(getHomeCollectionContext).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/home-collections/[id] (reschedule)', () => {
  const BODY = { visitDate: '2099-07-03', windowId: 4, reason: 'patient_request' }
  it('reschedules and notifies with the reschedule count in the dedupe key', async () => {
    vi.mocked(rescheduleHomeCollection).mockResolvedValue({ ok: true, visit: { ...VISIT, visitDate: '2099-07-03', windowLabel: 'Evening', rescheduleCount: 2 } as never })
    const res = await RESCHEDULE(send('PATCH', BODY), ctx('77'))
    expect(res.status).toBe(200)
    expect(rescheduleHomeCollection).toHaveBeenCalledWith(77, BODY, expect.objectContaining({ role: 'frontdesk' }))
    expect(notifyPatientSafely).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      templateKey: 'home_collection_rescheduled',
      vars: { hospitalName: brand.name, visitDate: '2099-07-03', windowLabel: 'Evening' },
      dedupeKey: 'home_collection_rescheduled:visit=77:n=2',
    }))
  })

  it.each([
    ['same_slot', 400, 'Pick a different date or window.'],
    ['not_reschedulable', 409, 'Only a booked visit can be rescheduled.'],
    ['slot_full', 409, 'That collection window is full. Pick another window.'],
    ['not_found', 404, 'Home collection visit not found'],
  ] as const)('maps %s to %i', async (error, status, message) => {
    vi.mocked(rescheduleHomeCollection).mockResolvedValue({ ok: false, error })
    const res = await RESCHEDULE(send('PATCH', BODY), ctx('77'))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('requires a reason code and a valid id', async () => {
    expect((await RESCHEDULE(send('PATCH', { visitDate: '2099-07-03', windowId: 4 }), ctx('77'))).status).toBe(400)
    expect((await RESCHEDULE(send('PATCH', BODY), ctx('abc'))).status).toBe(400)
    expect(rescheduleHomeCollection).not.toHaveBeenCalled()
  })

  it('collector cannot reschedule', async () => {
    role = 'collector'
    expect((await RESCHEDULE(send('PATCH', '{not json'), ctx('77'))).status).toBe(403)
  })
})

describe('POST /api/home-collections/[id]/cancel', () => {
  it('cancels and notifies once with the visit dedupe key', async () => {
    vi.mocked(cancelHomeCollection).mockResolvedValue({ ok: true, visit: { ...VISIT, status: 'cancelled' } as never, releasedOrderIds: [11] })
    const res = await CANCEL(send('POST', { reason: 'patient_request', note: 'x' }), ctx('77'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, releasedOrderIds: [11] })
    expect(notifyPatientSafely).toHaveBeenCalledWith(expect.anything(), {
      patientId: 'RD-0001',
      templateKey: 'home_collection_cancelled',
      vars: { hospitalName: brand.name, visitDate: '2099-07-02' },
      related: { type: 'home_collection_visit', id: 77 },
      dedupeKey: 'home_collection_cancelled:visit=77',
    })
  })

  it("collector cancel of someone else's visit is 403", async () => {
    role = 'collector'
    vi.mocked(cancelHomeCollection).mockResolvedValue({ ok: false, error: 'not_assigned' })
    const res = await CANCEL(send('POST', { reason: 'patient_unavailable' }), ctx('77'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('maps reason_not_allowed, not_cancellable and not_found', async () => {
    vi.mocked(cancelHomeCollection).mockResolvedValue({ ok: false, error: 'reason_not_allowed' })
    expect((await CANCEL(send('POST', { reason: 'patient_request' }), ctx('77'))).status).toBe(400)
    vi.mocked(cancelHomeCollection).mockResolvedValue({ ok: false, error: 'not_cancellable' })
    expect((await CANCEL(send('POST', { reason: 'other' }), ctx('77'))).status).toBe(409)
    vi.mocked(cancelHomeCollection).mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await CANCEL(send('POST', { reason: 'other' }), ctx('77'))).status).toBe(404)
  })

  it('a reason code is required', async () => {
    expect((await CANCEL(send('POST', {}), ctx('77'))).status).toBe(400)
    expect((await CANCEL(send('POST', { reason: 'SECRET-free-text' }), ctx('77'))).status).toBe(400)
    expect(cancelHomeCollection).not.toHaveBeenCalled()
  })

  it.each(['pi', 'crc', 'billing'] as const)('%s cannot cancel', async (r) => {
    role = r
    expect((await CANCEL(send('POST', '{not json'), ctx('77'))).status).toBe(403)
  })
})

describe('PUT /api/home-collections/[id]/collector', () => {
  it('labs can assign a collector; frontdesk cannot', async () => {
    role = 'labs'
    vi.mocked(assignCollector).mockResolvedValue({ ok: true, visit: { ...VISIT, collectorUserId: 9 } as never })
    const res = await COLLECTOR(send('PUT', { collectorUserId: 9 }), ctx('77'))
    expect(res.status).toBe(200)
    expect(assignCollector).toHaveBeenCalledWith(77, 9, expect.objectContaining({ role: 'labs' }))
    role = 'frontdesk'
    const denied = await COLLECTOR(send('PUT', '{not json'), ctx('77'))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
    expect(assignCollector).toHaveBeenCalledTimes(1)
  })

  it('maps collector_not_found to 400 and not_assignable to 409; null unassigns', async () => {
    role = 'admin'
    vi.mocked(assignCollector).mockResolvedValue({ ok: false, error: 'collector_not_found' })
    expect((await COLLECTOR(send('PUT', { collectorUserId: 9 }), ctx('77'))).status).toBe(400)
    vi.mocked(assignCollector).mockResolvedValue({ ok: false, error: 'not_assignable' })
    expect((await COLLECTOR(send('PUT', { collectorUserId: 9 }), ctx('77'))).status).toBe(409)
    vi.mocked(assignCollector).mockResolvedValue({ ok: true, visit: VISIT as never })
    expect((await COLLECTOR(send('PUT', { collectorUserId: null }), ctx('77'))).status).toBe(200)
    expect(assignCollector).toHaveBeenLastCalledWith(77, null, expect.anything())
  })
})
