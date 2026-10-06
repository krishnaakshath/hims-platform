import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, and, gt, desc, inArray } from 'drizzle-orm'
import { POST as schedule } from '@/app/api/front-desk/assignments/[id]/schedule/route'
import { POST as decline } from '@/app/api/front-desk/assignments/[id]/decline/route'
import { getDb } from '@/db/client'
import { doctorAssignments, appointments, messages, auditLog } from '@/db/schema'
import { createDoctorAssignment, declineAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'
import { sendMessage } from '@/lib/queries/messages'
import { hasSchedulingConflict } from '@/lib/queries/appointments'

vi.mock('@/lib/queries/messages', async () => {
  const a = await vi.importActual<typeof import('@/lib/queries/messages')>('@/lib/queries/messages')
  return { ...a, sendMessage: vi.fn(a.sendMessage) }
})

// Pass-through spy so the concurrency test can hold both requests at the
// conflict check (after the pending-status read, before the appointment
// insert) and force the real race.
vi.mock('@/lib/queries/appointments', async () => {
  const a = await vi.importActual<typeof import('@/lib/queries/appointments')>('@/lib/queries/appointments')
  return { ...a, hasSchedulingConflict: vi.fn(a.hasSchedulingConflict) }
})

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))

// `listActiveProviders()` has no ORDER BY, so array position isn't a stable
// way to pick "the mocked PI's own provider row" vs. "someone else's" --
// look each up by name explicitly instead.
async function kunamProviderId(): Promise<number> {
  const providers = await listActiveProviders()
  const kunam = providers.find((p) => p.name.includes('Kunam'))
  if (!kunam) throw new Error('Seeded provider "Dr. R. Kunam" not found -- run npm run db:seed')
  return kunam.id
}

async function otherProviderId(): Promise<number> {
  const providers = await listActiveProviders()
  const other = providers.find((p) => !p.name.includes('Kunam'))
  if (!other) throw new Error('No non-Kunam provider found -- run npm run db:seed')
  return other.id
}

const createdAssignmentIds: number[] = []
const createdAppointmentIds: number[] = []
const createdMessageIds: number[] = []
const createdAuditIds: number[] = []

async function maxMessageId(): Promise<number> {
  const [row] = await getDb().select({ id: messages.id }).from(messages).orderBy(desc(messages.id)).limit(1)
  return row?.id ?? 0
}
async function maxAuditId(): Promise<number> {
  const [row] = await getDb().select({ id: auditLog.id }).from(auditLog).orderBy(desc(auditLog.id)).limit(1)
  return row?.id ?? 0
}
// System messages for a patient created after a high-water mark; tracked for cleanup.
async function systemMsgs(patientId: string, afterId: number) {
  const rows = await getDb().select().from(messages)
    .where(and(eq(messages.patientId, patientId), eq(messages.senderRole, 'system'), gt(messages.id, afterId)))
  for (const r of rows) if (!createdMessageIds.includes(r.id)) createdMessageIds.push(r.id)
  return rows
}
async function getRow(id: number) {
  const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, id))
  return row
}
function post(id: number, startsAt: string, endsAt: string) {
  const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ startsAt, endsAt }) })
  return schedule(req as never, { params: Promise.resolve({ id: String(id) }) })
}
async function newAssignment() {
  const providerId = await kunamProviderId()
  const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
  createdAssignmentIds.push(a.id)
  return a
}

afterEach(async () => {
  if (createdMessageIds.length > 0) await getDb().delete(messages).where(inArray(messages.id, createdMessageIds.splice(0)))
  if (createdAuditIds.length > 0) await getDb().delete(auditLog).where(inArray(auditLog.id, createdAuditIds.splice(0)))
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

describe('POST /api/front-desk/assignments/[id]/schedule', () => {
  it('creates the appointment and marks the assignment scheduled', async () => {
    const before = await maxMessageId()
    const providerId = await kunamProviderId()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ startsAt: '2026-11-03T09:00:00', endsAt: '2026-11-03T09:30:00' }) })
    const res = await schedule(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    createdAppointmentIds.push(body.appointmentId)
    expect(body.status).toBe('scheduled')
    await systemMsgs('RD-0001', before)
  })

  it('returns 403 for a frontdesk session (only the assigned doctor schedules)', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })
    const providerId = await kunamProviderId()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ startsAt: '2026-11-03T10:00:00', endsAt: '2026-11-03T10:30:00' }) })
    const res = await schedule(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(403)
  })

  it('returns 403 when the assignment belongs to a different provider than the calling PI', async () => {
    // A real provider that is NOT "Dr. R. Kunam" (the mocked session's name) -- this
    // assignment was routed to a different doctor entirely.
    const providerId = await otherProviderId()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ startsAt: '2026-11-03T11:00:00', endsAt: '2026-11-03T11:30:00' }) })
    const res = await schedule(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/front-desk/assignments/[id]/schedule -- notification and status guard', () => {
  it('success inserts exactly one system message for that patient and sets patientNotifiedAt', async () => {
    const before = await maxMessageId()
    const a = await newAssignment()
    const res = await post(a.id, '2026-11-04T09:00:00', '2026-11-04T09:30:00')
    expect(res.status).toBe(200)
    const body = await res.json()
    createdAppointmentIds.push(body.appointmentId)
    // Track the message for cleanup before any assertion can fail.
    const msgs = await systemMsgs('RD-0001', before)
    // The response reflects the post-notify row, not the pre-notify one.
    expect(body.patientNotifiedAt).not.toBeNull()
    expect(msgs).toHaveLength(1)
    expect(await systemMsgs('RD-0002', before)).toHaveLength(0)
    expect((await getRow(a.id)).patientNotifiedAt).not.toBeNull()
  })

  it('second POST on a scheduled assignment -> 409, no second appointment, still one message', async () => {
    const before = await maxMessageId()
    const a = await newAssignment()
    const first = await post(a.id, '2026-11-05T09:00:00', '2026-11-05T09:30:00')
    expect(first.status).toBe(200)
    const apptId = (await first.json()).appointmentId
    createdAppointmentIds.push(apptId)

    const second = await post(a.id, '2026-11-05T10:00:00', '2026-11-05T10:30:00')
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'This assignment has already been scheduled or declined.' })
    const providerId = await kunamProviderId()
    const stray = await getDb().select().from(appointments)
      .where(and(eq(appointments.providerId, providerId), eq(appointments.startsAt, new Date('2026-11-05T10:00:00'))))
    for (const r of stray) createdAppointmentIds.push(r.id)
    expect(stray).toHaveLength(0)
    expect(await systemMsgs('RD-0001', before)).toHaveLength(1)
    expect((await getRow(a.id)).appointmentId).toBe(apptId)
  })

  it('two truly concurrent POSTs -> one 200, one 409, exactly one appointment and one message', async () => {
    const before = await maxMessageId()
    const a = await newAssignment()
    const providerId = await kunamProviderId()
    const slots = ['2026-11-09T09:00:00', '2026-11-09T10:00:00']
    // Barrier: neither request continues past the conflict check until both
    // have read the assignment as pending.
    const actual = (await vi.importActual<typeof import('@/lib/queries/appointments')>('@/lib/queries/appointments')).hasSchedulingConflict
    let arrived = 0
    let release!: () => void
    const bothArrived = new Promise<void>((r) => { release = r })
    vi.mocked(hasSchedulingConflict).mockImplementation(async (...args) => {
      if (++arrived === 2) release()
      await bothArrived
      return actual(...args)
    })
    const results = await Promise.all([
      post(a.id, slots[0], '2026-11-09T09:30:00'),
      post(a.id, slots[1], '2026-11-09T10:30:00'),
    ])
    // Track every appointment in either slot for cleanup before asserting.
    const appts = await getDb().select().from(appointments)
      .where(and(eq(appointments.providerId, providerId), inArray(appointments.startsAt, slots.map((s) => new Date(s)))))
    for (const r of appts) createdAppointmentIds.push(r.id)
    const msgs = await systemMsgs('RD-0001', before)
    vi.mocked(hasSchedulingConflict).mockImplementation(actual)
    expect(arrived).toBe(2)

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const loser = results.find((r) => r.status === 409)!
    expect(await loser.json()).toEqual({ error: 'This assignment has already been scheduled or declined.' })
    expect(appts).toHaveLength(1)
    expect(msgs).toHaveLength(1)
    const row = await getRow(a.id)
    expect(row.status).toBe('scheduled')
    expect(row.appointmentId).toBe(appts[0].id)
  })

  it('POST on a declined assignment -> 409', async () => {
    const before = await maxMessageId()
    const a = await newAssignment()
    await declineAssignment(a.id, 'Fully booked')
    const res = await post(a.id, '2026-11-06T09:00:00', '2026-11-06T09:30:00')
    expect(res.status).toBe(409)
    expect((await getRow(a.id)).status).toBe('declined')
    expect(await systemMsgs('RD-0001', before)).toHaveLength(0)
  })

  it('send failure -> 500, patientNotifiedAt null, still scheduled, no message, failure audited', async () => {
    const before = await maxMessageId()
    const auditBefore = await maxAuditId()
    const a = await newAssignment()
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(a.id, '2026-11-07T09:00:00', '2026-11-07T09:30:00')
    errSpy.mockRestore()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'The appointment was scheduled, but the confirmation message to the patient could not be sent. Please message the patient manually.' })
    const row = await getRow(a.id)
    expect(row.status).toBe('scheduled')
    expect(row.patientNotifiedAt).toBeNull()
    expect(row.appointmentId).not.toBeNull()
    createdAppointmentIds.push(row.appointmentId!)
    const [appt] = await getDb().select().from(appointments).where(eq(appointments.id, row.appointmentId!))
    expect(appt).toBeDefined()
    expect(await systemMsgs('RD-0001', before)).toHaveLength(0)
    const audits = await getDb().select().from(auditLog)
      .where(and(gt(auditLog.id, auditBefore), eq(auditLog.action, 'scheduled assignment into appointment; patient notification FAILED'), eq(auditLog.patientId, 'RD-0001')))
    for (const r of audits) createdAuditIds.push(r.id)
    expect(audits.length).toBeGreaterThanOrEqual(1)
  })
})

describe('POST /api/front-desk/assignments/[id]/schedule -- visit reason is server-side only', () => {
  it('uses the stored assignment.reason for the appointment and the patient message', async () => {
    const before = await maxMessageId()
    const providerId = await kunamProviderId()
    const storedReason = `Stored check-in reason ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: storedReason, roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(a.id)

    const res = await post(a.id, '2026-11-11T09:00:00', '2026-11-11T09:30:00')
    // Record everything created for cleanup before asserting.
    const appts = await getDb().select().from(appointments)
      .where(and(eq(appointments.providerId, providerId), eq(appointments.startsAt, new Date('2026-11-11T09:00:00'))))
    for (const r of appts) createdAppointmentIds.push(r.id)
    const msgs = await systemMsgs('RD-0001', before)

    expect(res.status).toBe(200)
    expect(appts).toHaveLength(1)
    expect(appts[0].visitReason).toBe(storedReason)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].body).toContain(`Reason for visit: ${storedReason}`)
  })

  it('rejects a client-supplied visitReason with the same 400 as any unknown key; nothing is created', async () => {
    const before = await maxMessageId()
    const providerId = await kunamProviderId()
    const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(a.id)

    async function postBody(body: Record<string, unknown>) {
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) })
      return schedule(req as never, { params: Promise.resolve({ id: String(a.id) }) })
    }
    const times = { startsAt: '2026-11-12T09:00:00', endsAt: '2026-11-12T09:30:00' }
    const withReason = await postBody({ ...times, visitReason: 'Crafted text for the patient' })
    const withUnknown = await postBody({ ...times, somethingElse: 'x' })
    const appts = await getDb().select().from(appointments)
      .where(and(eq(appointments.providerId, providerId), eq(appointments.startsAt, new Date(times.startsAt))))
    for (const r of appts) createdAppointmentIds.push(r.id)
    const msgs = await systemMsgs('RD-0001', before)

    expect(withReason.status).toBe(400)
    expect(withUnknown.status).toBe(400)
    const reasonBody = await withReason.json()
    const unknownBody = await withUnknown.json()
    expect(reasonBody.error).toBe('Invalid schedule payload')
    expect(reasonBody.error).toBe(unknownBody.error)
    expect(reasonBody.details.formErrors.join(' ')).toContain('visitReason')
    expect(appts).toHaveLength(0)
    expect(msgs).toHaveLength(0)
    expect((await getRow(a.id)).status).toBe('pending')
  })
})

describe('POST /api/front-desk/assignments/[id]/schedule -- empty session name', () => {
  // An empty last name used to match the first active provider via
  // includes(''), letting the session act on that provider's assignments.
  it.each([
    ['', '2026-11-10T09:00:00', '2026-11-10T09:30:00'],
    ['   ', '2026-11-10T10:00:00', '2026-11-10T10:30:00'],
  ])('pi named %j -> 403, assignment stays pending, no appointment or message', async (name, startsAt, endsAt) => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name, userId: null })
    const before = await maxMessageId()
    // The provider the old includes('') fallback would have matched.
    const providerId = (await listActiveProviders())[0].id
    const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(a.id)

    const res = await post(a.id, startsAt, endsAt)
    // Record anything created for cleanup before asserting.
    const appts = await getDb().select().from(appointments)
      .where(and(eq(appointments.providerId, providerId), eq(appointments.startsAt, new Date(startsAt))))
    for (const r of appts) createdAppointmentIds.push(r.id)
    const msgs = await systemMsgs('RD-0001', before)

    expect(res.status).toBe(403)
    expect(appts).toHaveLength(0)
    expect(msgs).toHaveLength(0)
    const row = await getRow(a.id)
    expect(row.status).toBe('pending')
    expect(row.appointmentId).toBeNull()
  })
})

describe('POST /api/front-desk/assignments/[id]/decline', () => {
  it('marks the assignment declined with the given reason', async () => {
    const providerId = await kunamProviderId()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Fully booked this week' }) })
    const res = await decline(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('declined')
    expect(body.declineReason).toBe('Fully booked this week')
  })

  it('returns 403 when the assignment belongs to a different provider than the calling PI', async () => {
    const providerId = await otherProviderId()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Not mine' }) })
    const res = await decline(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(403)

    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignment.id))
    expect(row.status).toBe('pending')
  })
})
