import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, appointments, departments, doctorAssignments, encounters, followUpOrders, providers, type EncounterRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { istDateOf, startOfIstDay } from '@/lib/india-time'
import { canTransitionEncounter, defaultEncounterVisitType, type EncounterStatus, type EncounterType, type EncounterVisitType } from '@/lib/encounters/status'
import type { DoctorAssignmentRow } from './doctor-assignments'
import type { WriteExecutor } from './executor'

export type Encounter = EncounterRow

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The next OPD token for an IST business date. MUST be called inside a
 * transaction: the advisory lock is transaction-scoped, so it serialises every
 * allocation for that date until the caller commits or rolls back. Because the
 * token is `max + 1` (not a sequence), a rolled-back check-in never burns a
 * number: the next caller sees the same max. The unique
 * (encounter_date, opd_token) index is the backstop.
 *
 * The second term covers the lobby board on deploy day: legacy count-based
 * tickets created during that IST day already exist on doctor_assignments, and
 * the new token must not collide with any of them.
 */
export async function allocateOpdToken(executor: WriteExecutor, encounterDate: string): Promise<number> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${'encounters.opd_token:' + encounterDate}))`)
  const [enc] = await executor
    .select({ max: sql<number | string | null>`max(${encounters.opdToken})` })
    .from(encounters)
    .where(eq(encounters.encounterDate, encounterDate))
  const dayStart = startOfIstDay(encounterDate)
  const nextDayStart = new Date(dayStart.getTime() + DAY_MS) // IST has no DST
  const [legacy] = await executor
    .select({ max: sql<number | string | null>`max(${doctorAssignments.queueTicketNumber})` })
    .from(doctorAssignments)
    .where(and(gte(doctorAssignments.createdAt, dayStart), lt(doctorAssignments.createdAt, nextDayStart)))
  return Math.max(Number(enc?.max ?? 0), Number(legacy?.max ?? 0)) + 1
}

export interface CheckInVisitInput {
  patientId: string
  providerId: number
  visitType: 'inpatient' | 'outpatient'
  urgency: 'routine' | 'urgent' | 'emergency'
  reason: string
  roomId: number | null
  appointmentId: number | null
  createAdmission: boolean
}

export type CheckInVisitError = 'appointment_not_found' | 'appointment_mismatch' | 'appointment_not_scheduled' | 'appointment_not_today' | 'appointment_already_checked_in'

export type CheckInVisitResult =
  | { ok: true; assignment: DoctorAssignmentRow; encounter: Encounter; admissionId: number | null; completedFollowUpOrderId: number | null }
  | { ok: false; error: CheckInVisitError }

/**
 * The whole front-desk check-in as ONE transaction: the linked follow-up order
 * and the appointment (row-locked, in that order), OPD token, the doctor assignment (its lobby ticket is the
 * token), the optional admission, the encounter, completing a booked
 * follow-up, and the audit rows. Any failure rolls all of it back.
 * `now` is the check-in instant; the business date is its IST date.
 */
export async function checkInVisit(input: CheckInVisitInput, session: Session, now: Date = new Date()): Promise<CheckInVisitResult> {
  return getDb().transaction(async (tx): Promise<CheckInVisitResult> => {
    const encounterDate = istDateOf(now)

    // Global lock order (I1): follow-up order -> appointment -> OPD token -> encounter.
    // bookFollowUp / unbookFollowUp / cancelFollowUpOrder lock the order first and
    // then the appointment, so check-in must too, or the two deadlock (40P01).
    // A writer that unbooked meanwhile set appointment_id to null: Postgres
    // re-checks the predicate after the wait, so that order is simply not returned.
    let order: { id: number } | undefined
    if (input.appointmentId !== null) {
      const linked = await tx
        .select({ id: followUpOrders.id, status: followUpOrders.status })
        .from(followUpOrders)
        .where(eq(followUpOrders.appointmentId, input.appointmentId))
        .orderBy(asc(followUpOrders.id))
        .for('update')
      order = linked.find((o) => o.status === 'scheduled')

      // The row lock serialises two check-ins against one appointment: the
      // second waits, then sees the first one's encounter below.
      const [appt] = await tx.select().from(appointments).where(eq(appointments.id, input.appointmentId)).for('update')
      if (!appt) return { ok: false, error: 'appointment_not_found' }
      if (appt.patientId !== input.patientId || appt.providerId !== input.providerId) return { ok: false, error: 'appointment_mismatch' }
      if (appt.status !== 'scheduled') return { ok: false, error: 'appointment_not_scheduled' }
      if (istDateOf(appt.startsAt) !== encounterDate) return { ok: false, error: 'appointment_not_today' }
      const [existing] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.appointmentId, input.appointmentId))
      if (existing) return { ok: false, error: 'appointment_already_checked_in' }
    }

    const token = await allocateOpdToken(tx, encounterDate)

    const [assignment] = await tx.insert(doctorAssignments).values({
      patientId: input.patientId,
      providerId: input.providerId,
      visitType: input.visitType,
      urgency: input.urgency,
      reason: input.reason,
      roomId: input.roomId,
      assignedByName: session.name,
      // A booked appointment needs no second accept from the doctor's queue.
      status: input.appointmentId !== null ? 'scheduled' : 'pending',
      appointmentId: input.appointmentId,
      queueTicketNumber: token,
      createdAt: now,
    }).returning()

    let admissionId: number | null = null
    if (input.createAdmission) {
      const [admission] = await tx.insert(admissions).values({
        patientId: input.patientId,
        currentRoomId: input.roomId,
        attendingProviderId: input.providerId,
        admissionType: 'elective',
        createdFromAssignmentId: assignment.id,
      }).returning({ id: admissions.id })
      admissionId = admission.id
    }

    const [provider] = await tx.select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, input.providerId))

    const [encounter] = await tx.insert(encounters).values({
      patientId: input.patientId,
      encounterType: input.visitType === 'inpatient' ? 'ipd' : 'opd',
      visitType: defaultEncounterVisitType({ urgency: input.urgency, followUpLinked: !!order }),
      status: 'checked_in',
      encounterDate,
      opdToken: token,
      departmentId: provider?.departmentId ?? null,
      providerId: input.providerId,
      appointmentId: input.appointmentId,
      admissionId,
      doctorAssignmentId: assignment.id,
      checkedInByName: session.name,
      checkedInAt: now,
    }).returning()

    if (order) {
      await tx.update(followUpOrders)
        .set({ status: 'completed', completedAt: now, completedEncounterId: encounter.id, updatedAt: now })
        .where(eq(followUpOrders.id, order.id))
    }

    // Ids and codes only -- never the visit reason.
    await logAudit(session, `checked in patient (${input.visitType})`, input.patientId, `encounter=${encounter.id} token=${token}`, tx)
    if (order) await logAudit(session, 'completed follow-up at check-in', input.patientId, `followUp=${order.id} encounter=${encounter.id}`, tx)

    return { ok: true, assignment, encounter, admissionId, completedFollowUpOrderId: order?.id ?? null }
  })
}

export type TransitionEncounterResult = { ok: true; encounter: Encounter } | { ok: false; error: 'not_found' | 'not_owner' | 'invalid_transition' | 'admission_active' }

export async function transitionEncounter(
  id: number,
  to: 'in_consultation' | 'completed' | 'cancelled',
  session: Session,
  opts: { cancelReason?: string; actingProviderId?: number | null } = {},
): Promise<TransitionEncounterResult> {
  return getDb().transaction(async (tx): Promise<TransitionEncounterResult> => {
    // Global lock order (I1): follow-up orders before the encounter. Only a
    // cancel touches the orders this visit completed.
    const completedOrders = to === 'cancelled'
      ? await tx.select({ id: followUpOrders.id }).from(followUpOrders)
        .where(eq(followUpOrders.completedEncounterId, id)).orderBy(asc(followUpOrders.id)).for('update')
      : []
    const [current] = await tx.select().from(encounters).where(eq(encounters.id, id)).for('update')
    if (!current) return { ok: false, error: 'not_found' }
    // A doctor (pi) acts as their own provider profile: only the visit's doctor moves it on.
    if (opts.actingProviderId != null && current.providerId !== opts.actingProviderId) return { ok: false, error: 'not_owner' }
    if (!canTransitionEncounter(current.status, to)) return { ok: false, error: 'invalid_transition' }
    // M8: an inpatient stay is ended by discharge; the front desk cannot cancel
    // the IPD visit while its admission is still active.
    if (to === 'cancelled' && session.role === 'frontdesk' && current.encounterType === 'ipd' && current.admissionId !== null) {
      const [adm] = await tx.select({ status: admissions.status }).from(admissions).where(eq(admissions.id, current.admissionId))
      if (adm?.status === 'admitted') return { ok: false, error: 'admission_active' }
    }
    const at = new Date()
    const [updated] = await tx.update(encounters).set({
      status: to,
      statusChangedAt: at,
      statusChangedByName: session.name,
      ...(to === 'completed' ? { completedAt: at } : {}),
      // A cancelled visit releases its appointment (unique link), so the patient can be checked in again.
      ...(to === 'cancelled' ? { cancelReason: opts.cancelReason ?? null, appointmentId: null } : {}),
    }).where(eq(encounters.id, id)).returning()
    // The cancel reason is free text: it stays on the row, never in the audit log.
    await logAudit(session, `encounter status changed to ${to}`, current.patientId, `encounter=${id}`, tx)

    // I6: the visit did not happen, so the follow-up it completed is open (booked) again.
    for (const o of completedOrders) {
      await tx.update(followUpOrders)
        .set({ status: 'scheduled', completedAt: null, completedEncounterId: null, updatedAt: at })
        .where(eq(followUpOrders.id, o.id))
      await logAudit(session, 'reopened follow-up after visit cancelled', current.patientId, `followUp=${o.id} encounter=${id}`, tx)
    }
    return { ok: true, encounter: updated }
  })
}

export async function getEncounterById(id: number, executor: WriteExecutor = getDb()): Promise<Encounter | null> {
  const [row] = await executor.select().from(encounters).where(eq(encounters.id, id))
  return row ?? null
}

export interface EncounterListRow {
  id: number
  encounterType: EncounterType
  visitType: EncounterVisitType
  status: EncounterStatus
  encounterDate: string
  opdToken: number | null
  providerId: number
  providerName: string
  departmentName: string | null
  appointmentId: number | null
  admissionId: number | null
  checkedInAt: Date
}

export async function listEncountersForPatient(patientId: string, limit = 20): Promise<EncounterListRow[]> {
  return getDb()
    .select({
      id: encounters.id,
      encounterType: encounters.encounterType,
      visitType: encounters.visitType,
      status: encounters.status,
      encounterDate: encounters.encounterDate,
      opdToken: encounters.opdToken,
      providerId: encounters.providerId,
      providerName: providers.name,
      departmentName: departments.name,
      appointmentId: encounters.appointmentId,
      admissionId: encounters.admissionId,
      checkedInAt: encounters.checkedInAt,
    })
    .from(encounters)
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .where(eq(encounters.patientId, patientId))
    .orderBy(desc(encounters.checkedInAt), desc(encounters.id))
    .limit(limit)
}

/**
 * Discharge (Task 10) closes the admission's IPD encounter on the caller's
 * transaction. Returns the encounter id, or null when there is no open one.
 */
export async function completeAdmissionEncounter(executor: WriteExecutor, admissionId: number, byName: string): Promise<number | null> {
  const at = new Date()
  const [row] = await executor.update(encounters)
    .set({ status: 'completed', completedAt: at, statusChangedAt: at, statusChangedByName: byName })
    .where(and(eq(encounters.admissionId, admissionId), eq(encounters.encounterType, 'ipd'), inArray(encounters.status, ['checked_in', 'in_consultation'])))
    .returning({ id: encounters.id })
  return row?.id ?? null
}
