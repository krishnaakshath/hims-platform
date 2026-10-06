import { describe, it, expect, afterEach, vi } from 'vitest'
import { and, eq, gte, inArray, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { doctorAssignments, appointments, patients, messages } from '@/db/schema'
import { createDoctorAssignment, listPendingAssignmentsForProvider, scheduleAssignment, declineAssignment, listTodaysAssignments, countPendingAssignmentsForProvider, countAllPendingAssignments, countUnacknowledgedDeclines, acknowledgeDecline, listAllAssignments, notifyPatientOfScheduledAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'
import { buildVisitConfirmationBody } from '@/lib/notification-templates'
import * as messagesModule from '@/lib/queries/messages'
import { SYSTEM_SENDER_NAME } from '@/lib/queries/eligibility'

// Pass-through spy on sendMessage so one test can force a failure inside the
// notify transaction; every other test runs the real implementation.
vi.mock('@/lib/queries/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/messages')>()
  return { ...actual, sendMessage: vi.fn(actual.sendMessage) }
})

const createdAssignmentIds: number[] = []
const createdAppointmentIds: number[] = []
const createdMessageIds: number[] = []
afterEach(async () => {
  // FK order: messages, then doctor_assignments, then appointments.
  if (createdMessageIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdMessageIds.splice(0)))
  }
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

describe('listPendingAssignmentsForProvider', () => {
  it('only returns pending assignments for the given provider', async () => {
    const providers = await listActiveProviders()
    const mine = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    const other = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[1].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(mine.id, other.id)

    const result = await listPendingAssignmentsForProvider(providers[0].id)
    expect(result.some((a) => a.id === mine.id)).toBe(true)
    expect(result.some((a) => a.id === other.id)).toBe(false)
  })
})

describe('scheduleAssignment', () => {
  it('sets status to scheduled and records the appointmentId', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)
    const [appointment] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: new Date('2026-11-02T09:00:00'), endsAt: new Date('2026-11-02T09:30:00'), visitReason: 'Test' }).returning()
    createdAppointmentIds.push(appointment.id)

    const updated = await scheduleAssignment(assignment.id, appointment.id)
    expect(updated?.status).toBe('scheduled')
    expect(updated?.appointmentId).toBe(appointment.id)
  })
  it('returns null and changes nothing when the assignment is no longer pending', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)
    const [first] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: new Date('2026-11-02T10:00:00'), endsAt: new Date('2026-11-02T10:30:00'), visitReason: 'Test' }).returning()
    const [second] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: new Date('2026-11-02T11:00:00'), endsAt: new Date('2026-11-02T11:30:00'), visitReason: 'Test' }).returning()
    createdAppointmentIds.push(first.id, second.id)

    expect((await scheduleAssignment(assignment.id, first.id))?.appointmentId).toBe(first.id)
    expect(await scheduleAssignment(assignment.id, second.id)).toBeNull()
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignment.id))
    expect(row.status).toBe('scheduled')
    expect(row.appointmentId).toBe(first.id)

    const declined = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(declined.id)
    await declineAssignment(declined.id, 'x')
    expect(await scheduleAssignment(declined.id, second.id)).toBeNull()
    const [drow] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, declined.id))
    expect(drow.status).toBe('declined')
    expect(drow.appointmentId).toBeNull()
  })
})

describe('declineAssignment', () => {
  it('returns null and leaves a scheduled row unchanged', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)
    const [appointment] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: new Date('2026-11-02T13:00:00'), endsAt: new Date('2026-11-02T13:30:00'), visitReason: 'Test' }).returning()
    createdAppointmentIds.push(appointment.id)
    await scheduleAssignment(assignment.id, appointment.id)

    expect(await declineAssignment(assignment.id, 'Too late')).toBeNull()
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignment.id))
    expect(row.status).toBe('scheduled')
    expect(row.appointmentId).toBe(appointment.id)
    expect(row.declineReason).toBeNull()
  })

  it('returns null on an already-declined row and keeps the original reason', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)
    expect((await declineAssignment(assignment.id, 'First reason'))?.declineReason).toBe('First reason')
    expect(await declineAssignment(assignment.id, 'Second reason')).toBeNull()
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignment.id))
    expect(row.status).toBe('declined')
    expect(row.declineReason).toBe('First reason')
  })

  it('sets status to declined and records the reason, leaving it visible', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const updated = await declineAssignment(assignment.id, 'Fully booked this week')
    expect(updated?.status).toBe('declined')
    expect(updated?.declineReason).toBe('Fully booked this week')

    const stillThere = await listPendingAssignmentsForProvider(providers[0].id)
    // Declined assignments are no longer "pending" for the doctor's queue,
    // but the row itself must still exist for reception to see and reassign.
    expect(stillThere.some((a) => a.id === assignment.id)).toBe(false)
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignment.id))
    expect(row).toBeDefined()
    expect(row.status).toBe('declined')
  })
})

describe('listTodaysAssignments', () => {
  it('includes an assignment created just now but excludes one created yesterday', async () => {
    const providers = await listActiveProviders()
    const today = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test today', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(today.id)

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const [oldRow] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test yesterday', assignedByName: 'Taylor Nguyen', createdAt: yesterday }).returning()
    createdAssignmentIds.push(oldRow.id)

    const result = await listTodaysAssignments()
    expect(result.some((a) => a.id === today.id)).toBe(true)
    expect(result.some((a) => a.id === oldRow.id)).toBe(false)
  })
})

// Task 17: the front-desk "Pending Assignments" tile showed 0 while
// /front-desk/assignments listed 1 pending (created the previous day) -- the
// tile counted today's rows only. A pending assignment is still pending the
// next day, so the tile counts by status across all days.
describe('countAllPendingAssignments', () => {
  it('counts a pending assignment created yesterday, ignores non-pending ones, and agrees with listAllAssignments', async () => {
    const providers = await listActiveProviders()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const before = await countAllPendingAssignments()

    const [oldPending] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'T17 pending yesterday', assignedByName: 'Taylor Nguyen', createdAt: yesterday }).returning()
    createdAssignmentIds.push(oldPending.id)
    const [oldDeclined] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'T17 declined yesterday', assignedByName: 'Taylor Nguyen', createdAt: yesterday, status: 'declined', declineReason: 'x' }).returning()
    createdAssignmentIds.push(oldDeclined.id)

    expect(await countAllPendingAssignments()).toBe(before + 1)
    expect((await listTodaysAssignments()).some((a) => a.id === oldPending.id)).toBe(false)

    const listed = await listAllAssignments()
    const [count, listedPending] = [await countAllPendingAssignments(), listed.filter((a) => a.status === 'pending').length]
    expect(count).toBe(listedPending)
  })
})

type Urg = 'routine' | 'urgent' | 'emergency'
async function mk(providerId: number, urgency: Urg = 'routine') {
  const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId, visitType: 'outpatient', urgency, reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
  createdAssignmentIds.push(a.id)
  return a
}

describe('urgency ordering and patient name', () => {
  it('orders emergency > urgent > routine, oldest first within a band', async () => {
    const [p] = await listActiveProviders()
    const r1 = await mk(p.id, 'routine')
    const e = await mk(p.id, 'emergency')
    const r2 = await mk(p.id, 'routine')
    const u = await mk(p.id, 'urgent')
    const ids = new Set([r1.id, e.id, r2.id, u.id])
    const result = (await listPendingAssignmentsForProvider(p.id)).filter((a) => ids.has(a.id)).map((a) => a.id)
    expect(result).toEqual([e.id, u.id, r1.id, r2.id])
  })

  it('returns patientName from patients.name', async () => {
    const [p] = await listActiveProviders()
    const a = await mk(p.id)
    const [pt] = await getDb().select({ name: patients.name }).from(patients).where(eq(patients.id, 'RD-0001'))
    const row = (await listPendingAssignmentsForProvider(p.id)).find((x) => x.id === a.id)
    expect(row?.patientName).toBe(pt.name)
  })
})

describe('counts and acknowledge', () => {
  it("countPendingAssignmentsForProvider counts only that provider's pending rows", async () => {
    const [p] = await listActiveProviders()
    const before = await countPendingAssignmentsForProvider(p.id)
    await mk(p.id)
    await mk(p.id)
    const d = await mk(p.id)
    await declineAssignment(d.id, 'No room')
    expect(await countPendingAssignmentsForProvider(p.id)).toBe(before + 2)
  })

  it('countUnacknowledgedDeclines tracks decline and acknowledge', async () => {
    const [p] = await listActiveProviders()
    const before = await countUnacknowledgedDeclines()
    const a = await mk(p.id)
    await declineAssignment(a.id, 'No room')
    expect(await countUnacknowledgedDeclines()).toBe(before + 1)
    const ack = await acknowledgeDecline(a.id, 'Taylor Nguyen')
    expect(ack?.declineAcknowledgedByName).toBe('Taylor Nguyen')
    expect(ack?.declineAcknowledgedAt).not.toBeNull()
    expect(await countUnacknowledgedDeclines()).toBe(before)
  })

  it('acknowledgeDecline returns null for pending or already-acknowledged rows', async () => {
    const [p] = await listActiveProviders()
    const a = await mk(p.id)
    expect(await acknowledgeDecline(a.id, 'Taylor Nguyen')).toBeNull()
    await declineAssignment(a.id, 'No room')
    expect(await acknowledgeDecline(a.id, 'Taylor Nguyen')).not.toBeNull()
    expect(await acknowledgeDecline(a.id, 'Someone Else')).toBeNull()
  })
})

describe('listAllAssignments ordering', () => {
  it('puts an unacknowledged decline before a newer pending row', async () => {
    const [p] = await listActiveProviders()
    const d = await mk(p.id)
    await declineAssignment(d.id, 'No room')
    const pend = await mk(p.id)
    const ids = (await listAllAssignments()).map((a) => a.id)
    expect(ids.indexOf(d.id)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(d.id)).toBeLessThan(ids.indexOf(pend.id))
  })
})

describe('notifyPatientOfScheduledAssignment', () => {
  // Unique per test so a stray confirmation from another process on the
  // shared DB can never be counted as ours.
  let visitReason = ''
  async function setup(visitType: 'inpatient' | 'outpatient' = 'outpatient') {
    visitReason = `Notify test visit ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const [p] = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: p.id, visitType, urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)
    const [appointment] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: p.id, startsAt: new Date('2026-11-02T09:00:00'), endsAt: new Date('2026-11-02T09:30:00'), visitReason }).returning()
    createdAppointmentIds.push(appointment.id)
    const scheduled = (await scheduleAssignment(assignment.id, appointment.id))!
    return { scheduled, appointment, providerName: p.name }
  }

  // Messages this test created: system, for RD-0001, since testStart, with
  // the confirmation header. Ids are tracked for explicit-id cleanup.
  async function confirmationsSince(testStart: Date) {
    const rows = await getDb().select().from(messages).where(and(
      eq(messages.patientId, 'RD-0001'),
      eq(messages.senderRole, 'system'),
      gte(messages.createdAt, testStart),
      like(messages.body, '%Your visit is confirmed.%'),
      like(messages.body, `%Reason for visit: ${visitReason}%`),
    ))
    for (const r of rows) if (!createdMessageIds.includes(r.id)) createdMessageIds.push(r.id)
    return rows
  }

  async function notifiedAt(id: number) {
    const [row] = await getDb().select({ patientNotifiedAt: doctorAssignments.patientNotifiedAt }).from(doctorAssignments).where(eq(doctorAssignments.id, id))
    return row.patientNotifiedAt
  }

  it('first call sends one system message with the template body and sets patientNotifiedAt', async () => {
    const testStart = new Date(Date.now() - 5000)
    const { scheduled, appointment, providerName } = await setup()
    await notifyPatientOfScheduledAssignment(scheduled, appointment, providerName)
    const rows = await confirmationsSince(testStart)
    expect(rows).toHaveLength(1)
    expect(rows[0].senderName).toBe(SYSTEM_SENDER_NAME)
    expect(rows[0].internal).toBe(false)
    expect(rows[0].body).toBe(buildVisitConfirmationBody({ providerName, startsAt: appointment.startsAt, visitReason, visitType: 'outpatient' }))
    expect(rows[0].body).not.toContain('• An overnight bag')
    expect(await notifiedAt(scheduled.id)).not.toBeNull()
  })

  it('sends exactly one system message when called twice', async () => {
    const testStart = new Date(Date.now() - 5000)
    const { scheduled, appointment, providerName } = await setup()
    await notifyPatientOfScheduledAssignment(scheduled, appointment, providerName)
    const first = await notifiedAt(scheduled.id)
    await notifyPatientOfScheduledAssignment(scheduled, appointment, providerName)
    const rows = await confirmationsSince(testStart)
    expect(rows).toHaveLength(1)
    expect(rows[0].senderName).toBe(SYSTEM_SENDER_NAME)
    // Second call is a no-op: the timestamp is not overwritten.
    expect((await notifiedAt(scheduled.id))?.getTime()).toBe(first?.getTime())
  })

  it('concurrent calls send exactly one message', async () => {
    const testStart = new Date(Date.now() - 5000)
    const { scheduled, appointment, providerName } = await setup()
    await Promise.all([
      notifyPatientOfScheduledAssignment(scheduled, appointment, providerName),
      notifyPatientOfScheduledAssignment(scheduled, appointment, providerName),
    ])
    expect(await confirmationsSince(testStart)).toHaveLength(1)
    expect(await notifiedAt(scheduled.id)).not.toBeNull()
  })

  it('a failed send rolls back: patientNotifiedAt stays null and no message exists', async () => {
    const testStart = new Date(Date.now() - 5000)
    const { scheduled, appointment, providerName } = await setup()
    const spy = vi.mocked(messagesModule.sendMessage)
    const real = (await vi.importActual<typeof import('@/lib/queries/messages')>('@/lib/queries/messages')).sendMessage
    // Perform the real insert on the transaction, then throw, proving both
    // the claim and the already-inserted message are rolled back together.
    spy.mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await real(...args)
      throw new Error('forced send failure')
    })
    await expect(notifyPatientOfScheduledAssignment(scheduled, appointment, providerName)).rejects.toThrow('forced send failure')
    expect(await notifiedAt(scheduled.id)).toBeNull()
    expect(await confirmationsSince(testStart)).toHaveLength(0)
  })

  it('inpatient assignment message includes the overnight bag bullet', async () => {
    const testStart = new Date(Date.now() - 5000)
    const { scheduled, appointment, providerName } = await setup('inpatient')
    await notifyPatientOfScheduledAssignment(scheduled, appointment, providerName)
    const rows = await confirmationsSince(testStart)
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toContain('• An overnight bag')
  })
})
