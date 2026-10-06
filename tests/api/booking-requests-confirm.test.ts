import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PATCH as confirmRoute } from '@/app/api/booking-requests/[id]/confirm/route'
import { PATCH as declineRoute } from '@/app/api/booking-requests/[id]/decline/route'
import { getDb } from '@/db/client'
import { bookingRequests, appointments, patients } from '@/db/schema'
import { createBookingRequest } from '@/lib/queries/booking-requests'
import { listActiveProviders } from '@/lib/queries/providers'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Staff Member' })) }))

const createdRequestIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'frontdesk'
  while (createdRequestIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdRequestIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

function params(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) }
}

async function makePendingRequest() {
  const row = await createBookingRequest({
    requesterName: 'Morgan Lee',
    requesterDob: '1985-06-20',
    requesterEmail: 'morgan@example.com',
    requesterPhone: null,
    preferredProviderId: null,
    preferredDateRangeStart: '2026-11-01',
    preferredDateRangeEnd: '2026-11-10',
    reason: 'New patient intake',
  })
  createdRequestIds.push(row.id)
  return row
}

async function confirmPayload() {
  const providers = await listActiveProviders()
  const [patient] = await getDb().select().from(patients).limit(1)
  return {
    patientId: patient.id,
    providerId: providers[0].id,
    startsAt: new Date('2026-12-10T10:00:00Z').toISOString(),
    endsAt: new Date('2026-12-10T10:30:00Z').toISOString(),
    visitReason: 'New patient intake',
  }
}

describe('PATCH /api/booking-requests/[id]/confirm', () => {
  it.each(['admin', 'crc', 'frontdesk'] as const)('allows a %s session to confirm', async (role) => {
    sessionRole = role
    const request = await makePendingRequest()
    const payload = await confirmPayload()
    const res = await confirmRoute(req(payload) as never, params(request.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    createdAppointmentIds.push(body.appointmentId)
  })

  it('rejects a pi session with 403', async () => {
    sessionRole = 'pi'
    const request = await makePendingRequest()
    const payload = await confirmPayload()
    const res = await confirmRoute(req(payload) as never, params(request.id))
    expect(res.status).toBe(403)
  })

  it('returns 409 on an already-resolved request instead of silently re-processing', async () => {
    const request = await makePendingRequest()
    const payload = await confirmPayload()
    const first = await confirmRoute(req(payload) as never, params(request.id))
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    createdAppointmentIds.push(firstBody.appointmentId)

    const second = await confirmRoute(req(payload) as never, params(request.id))
    expect(second.status).toBe(409)

    const apptRows = await getDb().select().from(appointments).where(eq(appointments.patientId, payload.patientId))
    const relevantRows = apptRows.filter((r) => r.visitReason === 'New patient intake' && r.startsAt.toISOString() === payload.startsAt)
    expect(relevantRows.length).toBe(1)
  })

  it('returns 404 for an unknown request id', async () => {
    const payload = await confirmPayload()
    const res = await confirmRoute(req(payload) as never, params(999999999))
    expect(res.status).toBe(404)
  })

  it('returns 400 for a non-integer id', async () => {
    const payload = await confirmPayload()
    const res = await confirmRoute(req(payload) as never, params('not-a-number'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when endsAt is not after startsAt', async () => {
    const request = await makePendingRequest()
    const payload = await confirmPayload()
    const res = await confirmRoute(req({ ...payload, endsAt: payload.startsAt }) as never, params(request.id))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a patientId that does not reference a real patient, and never leaves the request stuck confirmed with no appointment', async () => {
    const request = await makePendingRequest()
    const payload = await confirmPayload()
    const res = await confirmRoute(req({ ...payload, patientId: 'RD-9999999-does-not-exist' }) as never, params(request.id))
    expect(res.status).toBe(400)

    const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, request.id))
    expect(row.status).toBe('pending')
    expect(row.resultingAppointmentId).toBeNull()

    const apptRows = await getDb().select().from(appointments).where(eq(appointments.patientId, 'RD-9999999-does-not-exist'))
    expect(apptRows.length).toBe(0)
  })
})

describe('PATCH /api/booking-requests/[id]/decline', () => {
  it.each(['admin', 'crc', 'frontdesk'] as const)('allows a %s session to decline', async (role) => {
    sessionRole = role
    const request = await makePendingRequest()
    const res = await declineRoute(req({ reason: 'No capacity in the requested window' }) as never, params(request.id))
    expect(res.status).toBe(200)
  })

  it('rejects a pi session with 403', async () => {
    sessionRole = 'pi'
    const request = await makePendingRequest()
    const res = await declineRoute(req({ reason: 'No capacity in the requested window' }) as never, params(request.id))
    expect(res.status).toBe(403)
  })

  it('returns 409 on an already-resolved request instead of silently re-processing', async () => {
    const request = await makePendingRequest()
    const first = await declineRoute(req({ reason: 'No capacity' }) as never, params(request.id))
    expect(first.status).toBe(200)

    const second = await declineRoute(req({ reason: 'Second attempt' }) as never, params(request.id))
    expect(second.status).toBe(409)

    const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, request.id))
    expect(row.declineReason).toBe('No capacity')
  })

  it('returns 404 for an unknown request id', async () => {
    const res = await declineRoute(req({ reason: 'No capacity' }) as never, params(999999999))
    expect(res.status).toBe(404)
  })

  it('returns 400 for a non-integer id', async () => {
    const res = await declineRoute(req({ reason: 'No capacity' }) as never, params('not-a-number'))
    expect(res.status).toBe(400)
  })

  it('never creates an appointments row', async () => {
    const request = await makePendingRequest()
    const before = await getDb().select().from(appointments)
    const res = await declineRoute(req({ reason: 'No capacity' }) as never, params(request.id))
    expect(res.status).toBe(200)
    const after = await getDb().select().from(appointments)
    expect(after.length).toBe(before.length)
  })
})

describe('PATCH /api/booking-requests/[id]/confirm -- visitReason length (patient-facing)', () => {
  const startsAt = new Date('2026-12-11T10:00:00Z').toISOString()
  const endsAt = new Date('2026-12-11T10:30:00Z').toISOString()

  async function apptsAtSlot() {
    const rows = await getDb().select().from(appointments).where(eq(appointments.startsAt, new Date(startsAt)))
    for (const r of rows) if (!createdAppointmentIds.includes(r.id)) createdAppointmentIds.push(r.id)
    return rows
  }

  it('rejects a 141-char visitReason with the existing 400 shape; request stays pending, no appointment', async () => {
    const request = await makePendingRequest()
    const visitReason = `len141-${Date.now()}-`.padEnd(141, 'x')
    const res = await confirmRoute(req({ ...(await confirmPayload()), startsAt, endsAt, visitReason }) as never, params(request.id))
    const appts = (await apptsAtSlot()).filter((a) => a.visitReason === visitReason)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid confirm payload')
    expect(body.details.fieldErrors.visitReason).toBeDefined()
    expect(appts).toHaveLength(0)
    const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, request.id))
    expect(row.status).toBe('pending')
  })

  it('accepts a 140-char visitReason (after trimming) and stores the trimmed value', async () => {
    const request = await makePendingRequest()
    const visitReason = `len140-${Date.now()}-`.padEnd(140, 'y')
    const res = await confirmRoute(req({ ...(await confirmPayload()), startsAt, endsAt, visitReason: `  ${visitReason}\t ` }) as never, params(request.id))
    const body = await res.json()
    if (body?.appointmentId) createdAppointmentIds.push(body.appointmentId)
    await apptsAtSlot()
    expect(res.status).toBe(200)
    const [appt] = await getDb().select().from(appointments).where(eq(appointments.id, body.appointmentId))
    expect(appt.visitReason).toBe(visitReason)
  })
})
