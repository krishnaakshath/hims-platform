import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { bookingRequests, appointments, patients } from '@/db/schema'
import { createBookingRequest, confirmBookingRequest, declineBookingRequest } from '@/lib/queries/booking-requests'
import { listActiveProviders } from '@/lib/queries/providers'

const createdIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

describe('createBookingRequest', () => {
  it('inserts a pending request with only the given fields set', async () => {
    const row = await createBookingRequest({
      requesterName: 'Alex Chen',
      requesterDob: '1992-08-01',
      requesterEmail: 'alex@example.com',
      requesterPhone: null,
      preferredProviderId: null,
      preferredDateRangeStart: '2026-11-01',
      preferredDateRangeEnd: '2026-11-10',
      reason: 'Initial consult',
    })
    createdIds.push(row.id)
    expect(row.status).toBe('pending')
    expect(row.reviewedByName).toBeNull()
    expect(row.resultingAppointmentId).toBeNull()
  })
})

async function makePendingRequest() {
  const row = await createBookingRequest({
    requesterName: 'Jamie Rivera',
    requesterDob: '1990-01-15',
    requesterEmail: 'jamie@example.com',
    requesterPhone: null,
    preferredProviderId: null,
    preferredDateRangeStart: '2026-11-01',
    preferredDateRangeEnd: '2026-11-10',
    reason: 'Follow-up consult',
  })
  createdIds.push(row.id)
  return row
}

describe('confirmBookingRequest', () => {
  it('creates a real appointments row and marks the request confirmed, pointing resultingAppointmentId at it', async () => {
    const request = await makePendingRequest()
    const providers = await listActiveProviders()
    const [patient] = await getDb().select().from(patients).limit(1)
    const startsAt = new Date('2026-12-01T10:00:00Z')
    const endsAt = new Date('2026-12-01T10:30:00Z')

    const result = await confirmBookingRequest(request.id, {
      patientId: patient.id,
      providerId: providers[0].id,
      startsAt,
      endsAt,
      visitReason: 'Follow-up consult',
      reviewedByName: 'Front Desk Staff',
    })

    expect(result.ok).toBe(true)
    expect(result.appointmentId).toBeDefined()
    createdAppointmentIds.push(result.appointmentId!)

    const [apptRow] = await getDb().select().from(appointments).where(eq(appointments.id, result.appointmentId!))
    expect(apptRow.patientId).toBe(patient.id)
    expect(apptRow.providerId).toBe(providers[0].id)
    expect(apptRow.startsAt.getTime()).toBe(startsAt.getTime())
    expect(apptRow.endsAt.getTime()).toBe(endsAt.getTime())

    const [updatedRequest] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, request.id))
    expect(updatedRequest.status).toBe('confirmed')
    expect(updatedRequest.resultingAppointmentId).toBe(result.appointmentId)
  })

  it('does not process a second confirm on the same request (no second appointments row)', async () => {
    const request = await makePendingRequest()
    const providers = await listActiveProviders()
    const [patient] = await getDb().select().from(patients).limit(1)
    const startsAt = new Date('2026-12-02T10:00:00Z')
    const endsAt = new Date('2026-12-02T10:30:00Z')

    const first = await confirmBookingRequest(request.id, {
      patientId: patient.id,
      providerId: providers[0].id,
      startsAt,
      endsAt,
      visitReason: 'Follow-up consult',
      reviewedByName: 'Front Desk Staff',
    })
    expect(first.ok).toBe(true)
    createdAppointmentIds.push(first.appointmentId!)

    const second = await confirmBookingRequest(request.id, {
      patientId: patient.id,
      providerId: providers[0].id,
      startsAt: new Date('2026-12-03T10:00:00Z'),
      endsAt: new Date('2026-12-03T10:30:00Z'),
      visitReason: 'Follow-up consult',
      reviewedByName: 'Front Desk Staff',
    })
    expect(second.ok).toBe(false)

    const apptRows = await getDb().select().from(appointments).where(eq(appointments.patientId, patient.id))
    const relevantRows = apptRows.filter((r) => r.visitReason === 'Follow-up consult' && r.providerId === providers[0].id)
    expect(relevantRows.length).toBe(1)
  })

  it('refuses to confirm into a conflicting window and leaves the request pending', async () => {
    const providers = await listActiveProviders()
    const [patient] = await getDb().select().from(patients).limit(1)
    const startsAt = new Date('2026-12-04T10:00:00Z')
    const endsAt = new Date('2026-12-04T10:30:00Z')

    const [existingAppt] = await getDb().insert(appointments).values({
      patientId: patient.id,
      providerId: providers[0].id,
      startsAt,
      endsAt,
      visitReason: 'Existing appointment',
      status: 'scheduled',
    }).returning()
    createdAppointmentIds.push(existingAppt.id)

    const request = await makePendingRequest()
    const result = await confirmBookingRequest(request.id, {
      patientId: patient.id,
      providerId: providers[0].id,
      startsAt,
      endsAt,
      visitReason: 'Follow-up consult',
      reviewedByName: 'Front Desk Staff',
    })
    expect(result.ok).toBe(false)

    const [unchangedRequest] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, request.id))
    expect(unchangedRequest.status).toBe('pending')
  })
})

describe('declineBookingRequest', () => {
  it('sets status to declined and declineReason, never creating an appointments row', async () => {
    const request = await makePendingRequest()
    const result = await declineBookingRequest(request.id, { reason: 'No providers available in the requested window', reviewedByName: 'Front Desk Staff' })
    expect(result.ok).toBe(true)

    const [updatedRequest] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, request.id))
    expect(updatedRequest.status).toBe('declined')
    expect(updatedRequest.declineReason).toBe('No providers available in the requested window')
    expect(updatedRequest.resultingAppointmentId).toBeNull()
  })

  it('returns { ok: false } on an already-resolved request', async () => {
    const request = await makePendingRequest()
    const first = await declineBookingRequest(request.id, { reason: 'First decline', reviewedByName: 'Front Desk Staff' })
    expect(first.ok).toBe(true)

    const second = await declineBookingRequest(request.id, { reason: 'Second decline', reviewedByName: 'Front Desk Staff' })
    expect(second.ok).toBe(false)
  })
})
