// Foundations T9: confirming a booking request records booking_confirmed for the patient.
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, auditLog, bookingRequests, notificationLog, patients } from '@/db/schema'
import { createBookingRequest } from '@/lib/queries/booking-requests'
import { makeFakeRegistry } from '../helpers/notify-fakes'

const fake = makeFakeRegistry()
vi.mock('@/lib/notify/registry', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/notify/registry')>()), getChannelRegistry: () => fake.registry }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'T9 Booking Staff', userId: null })) }))

const { PATCH } = await import('@/app/api/booking-requests/[id]/confirm/route')

const PID = `TEST-T9B-${Date.now()}`
const reqIds: number[] = []

describe.skipIf(!process.env.DATABASE_URL)('PATCH /api/booking-requests/[id]/confirm notifies', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values({ id: PID, name: 'TEST_T9 Booking', dob: '1980-01-01', phone: '+919845013212' })
  })
  afterAll(async () => {
    const db = getDb()
    await db.delete(notificationLog).where(eq(notificationLog.patientId, PID))
    for (const id of reqIds) await db.delete(bookingRequests).where(eq(bookingRequests.id, id))
    await db.delete(appointments).where(eq(appointments.patientId, PID))
    await db.delete(auditLog).where(eq(auditLog.userName, 'T9 Booking Staff'))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  it('records booking_confirmed with the request key, and a retried confirm does not send again', async () => {
    const r = await createBookingRequest({ requesterName: 'T9', requesterDob: '1985-06-20', requesterEmail: 't9@example.com', requesterPhone: null, preferredProviderId: null, preferredDateRangeStart: '2099-11-01', preferredDateRangeEnd: '2099-11-10', reason: 'T9' })
    reqIds.push(r.id)
    const payload = { patientId: PID, providerId: 1, startsAt: '2099-12-10T04:30:00Z', endsAt: '2099-12-10T05:00:00Z', visitReason: 'T9 booking' }
    const call = () => PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(payload) }) as never, { params: Promise.resolve({ id: String(r.id) }) })
    const res = await call()
    expect(res.status).toBe(200)
    const rows = await getDb().select().from(notificationLog).where(eq(notificationLog.patientId, PID))
    expect(rows.map((x) => [x.templateKey, x.channel, x.status, x.dedupeKey])).toEqual([
      ['booking_confirmed', 'sms', 'sent', `booking:${r.id}`],
      ['booking_confirmed', 'whatsapp', 'sent', `booking:${r.id}`],
    ])
    expect((fake.sends.sms.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('10 Dec 2099, 10:00 am')
    fake.sends.sms.mockClear()
    expect((await call()).status).toBe(409) // already resolved: no second notice
    expect(fake.sends.sms).not.toHaveBeenCalled()
  })
})
