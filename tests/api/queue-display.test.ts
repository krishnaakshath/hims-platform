import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appSettings, patients, doctorAssignments, appointments, admissions, rooms } from '@/db/schema'
import { GET } from '@/app/api/queue-display/route'
import { listActiveProviders } from '@/lib/queries/providers'
import { getAppSettings } from '@/lib/queries/settings'

const PIN_HEADER = 'x-queue-display-pin'
const TEST_PIN = 'lobby-4821'

interface ResponseTicket {
  ticketNumber: number
  urgency: 'routine' | 'urgent' | 'emergency'
  stage: 'waiting' | 'ready'
}

// A fixed, unique-per-suite-run IP for every test below that isn't itself
// exercising the rate limiter (Important #2's dedicated tests use their own
// per-test IPs) -- keeps this file's own ~10 requests well clear of the
// 20-per-60s queue-display-pin bucket across repeated runs, and clear of the
// rate-limit tests' buckets too.
const FUNCTIONAL_TEST_IP = `198.51.100.77-${Date.now()}`
const FUNCTIONAL_HEADERS = (pin?: string) => ({
  ...(pin ? { [PIN_HEADER]: pin } : {}),
  'x-forwarded-for': FUNCTIONAL_TEST_IP,
})

async function setPin(pin: string | null) {
  const [row] = await getDb().select().from(appSettings)
  await getDb().update(appSettings).set({ queueDisplayPin: pin }).where(eq(appSettings.id, row.id))
}

// This is the single shared app_settings row the real Settings page (and the
// real lobby display) reads. Several tests below write a real PIN to it via
// setPin(). Snapshot and restore it around the whole file (not per-test),
// same pattern as tests/api/settings-queue-display-pin.test.ts, so a run of
// this file never leaves the shared row's queueDisplayPin different from
// whatever a staff member actually configured on this shared Neon DB
// (Important #3 -- the old unconditional `afterEach(() => setPin(null))`
// destroyed the real PIN for every other worktree/staff member).
let originalSettings: Awaited<ReturnType<typeof getAppSettings>>
beforeAll(async () => {
  originalSettings = await getAppSettings()
})
afterAll(async () => {
  await getDb().update(appSettings).set({ queueDisplayPin: originalSettings.queueDisplayPin }).where(eq(appSettings.id, originalSettings.id))
})

const createdAssignmentIds: number[] = []
const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('GET /api/queue-display', () => {
  it('returns 401 when no PIN is set on appSettings (Review Focus #1)', async () => {
    await setPin(null)
    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS('anything') })
    const res = await GET(req as never)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the wrong PIN is supplied', async () => {
    await setPin(TEST_PIN)
    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS('wrong-pin') })
    const res = await GET(req as never)
    expect(res.status).toBe(401)
  })

  it('returns 401 when no PIN header is supplied at all', async () => {
    await setPin(TEST_PIN)
    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS() })
    const res = await GET(req as never)
    expect(res.status).toBe(401)
  })

  it('never includes a real patient name in the response body (Review Focus #2)', async () => {
    await setPin(TEST_PIN)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const realName = patientRow.name
    const providerRows = await listActiveProviders()
    const created = await getDb().insert(doctorAssignments).values({ patientId: patientRow.id, providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Should never appear', assignedByName: 'Test Staff', queueTicketNumber: 1 }).returning()
    createdAssignmentIds.push(created[0].id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const bodyText = await res.text()
    expect(res.status).toBe(200)
    if (realName) expect(bodyText.includes(realName)).toBe(false)
    expect(bodyText.includes('Should never appear')).toBe(false) // the reason
    expect(bodyText.includes(patientRow.id)).toBe(false) // not even the anonId
  })

  it('maps pending to "waiting" and scheduled+room to "ready"', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '901', bedNumber: 'A', status: 'occupied' }).returning()
    createdRoomIds.push(room.id)

    const [waiting] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 101, status: 'pending' }).returning()
    createdAssignmentIds.push(waiting.id)
    const [ready] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'inpatient', urgency: 'urgent', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 102, status: 'scheduled', roomId: room.id }).returning()
    createdAssignmentIds.push(ready.id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.find((t: ResponseTicket) => t.ticketNumber === 101)?.stage).toBe('waiting')
    expect(body.tickets.find((t: ResponseTicket) => t.ticketNumber === 102)?.stage).toBe('ready')
  })

  it('excludes a declined assignment', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [declined] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 201, status: 'declined', declineReason: 'x' }).returning()
    createdAssignmentIds.push(declined.id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 201)).toBe(false)
  })

  it('excludes an assignment that already has an active admission (Review Focus #3)', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [assignment] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'inpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 301, status: 'pending' }).returning()
    createdAssignmentIds.push(assignment.id)
    const [admission] = await getDb().insert(admissions).values({ patientId: 'RD-0001', attendingProviderId: providerRows[0].id, createdFromAssignmentId: assignment.id }).returning()
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 301)).toBe(false)
  })

  it('excludes an assignment whose appointment is already completed (Review Focus #3)', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [appointment] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'x', status: 'completed' }).returning()
    createdAppointmentIds.push(appointment.id)
    const [assignment] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 401, status: 'scheduled', appointmentId: appointment.id }).returning()
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 401)).toBe(false)
  })

  it('excludes an assignment whose appointment was cancelled or a no-show (bundled Minor #5)', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [cancelledAppt] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'x', status: 'cancelled' }).returning()
    createdAppointmentIds.push(cancelledAppt.id)
    const [noShowAppt] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'x', status: 'no_show' }).returning()
    createdAppointmentIds.push(noShowAppt.id)
    const [cancelledAssignment] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 501, status: 'scheduled', appointmentId: cancelledAppt.id }).returning()
    createdAssignmentIds.push(cancelledAssignment.id)
    const [noShowAssignment] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 502, status: 'scheduled', appointmentId: noShowAppt.id }).returning()
    createdAssignmentIds.push(noShowAssignment.id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 501)).toBe(false)
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 502)).toBe(false)
  })

  it('excludes a DEFAULT-0 sentinel ticket while including a real positive ticket (Important #1)', async () => {
    // queueTicketNumber DEFAULT 0 is a cross-worktree safety net (see the
    // comment on doctorAssignments in src/db/schema.ts), never a real
    // ticket -- two such rows were confirmed live on the shared dev DB and
    // would otherwise render as indistinguishable "0" cards on the public
    // lobby board.
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [sentinel] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 0, status: 'pending' }).returning()
    createdAssignmentIds.push(sentinel.id)
    const [real] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 601, status: 'pending' }).returning()
    createdAssignmentIds.push(real.id)

    const req = new Request('http://localhost/api/queue-display', { headers: FUNCTIONAL_HEADERS(TEST_PIN) })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 0)).toBe(false)
    expect(body.tickets.some((t: ResponseTicket) => t.ticketNumber === 601)).toBe(true)
  })

  describe('rate limiting (Important #2)', () => {
    it('does not trip the limit for a small number of requests comparable to the 8s polling cadence', async () => {
      await setPin(TEST_PIN)
      const ip = `198.51.100.201-${Date.now()}-${Math.random()}`
      for (let i = 0; i < 5; i++) {
        const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: TEST_PIN, 'x-forwarded-for': ip } })
        const res = await GET(req as never)
        expect(res.status).not.toBe(429)
        expect(res.status).toBe(200)
      }
    })

    it('eventually returns 429 for repeated failed requests from the same IP', async () => {
      await setPin(TEST_PIN)
      const ip = `198.51.100.202-${Date.now()}-${Math.random()}`
      let sawRateLimited = false
      for (let i = 0; i < 25; i++) {
        const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: 'wrong-pin-guess', 'x-forwarded-for': ip } })
        const res = await GET(req as never)
        if (res.status === 429) {
          sawRateLimited = true
          break
        }
        expect(res.status).toBe(401) // wrong PIN, not yet rate-limited
      }
      expect(sawRateLimited).toBe(true)
    })
  })
})
