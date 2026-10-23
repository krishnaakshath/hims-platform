import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, appointments, departments, doctorAssignments, encounters, followUpOrders, homeCollectionVisits, labOrders, labRequisitions, providers, type EncounterRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { istDateOf, startOfIstDay } from '@/lib/india-time'
import { canTransitionEncounter, defaultEncounterVisitType, type EncounterStatus, type EncounterType, type EncounterVisitType } from '@/lib/encounters/status'
import type { DoctorAssignmentRow } from './doctor-assignments'
import { captureVisitChargesInTx, ensureConsultationChargeInTx, voidAutoLinesForEncounterInTx, type AutoChargeOutcome } from './auto-charge' // WS2 T9
import type { WriteExecutor } from './executor'
import { cancelLabOrderInTx } from './lab-lifecycle' // WS2 T10
import type { LabOrderStatus } from '@/lib/labs/status' // WS2 T10
import { lockVisitProceduresInTx, voidVisitProceduresInTx } from './procedure-orders' // WS2 T11

// WS2 T10 (fix round 1): lab orders still waiting for their sample; anything later was performed.
const LAB_PENDING_STATUSES: readonly LabOrderStatus[] = ['ordered', 'scheduled']
const VISIT_CANCELLED_ORDER_REASON = 'Visit cancelled'

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
  | { ok: true; assignment: DoctorAssignmentRow; encounter: Encounter; admissionId: number | null; completedFollowUpOrderId: number | null; charges: AutoChargeOutcome[] }
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

    // Global lock order (I1): follow-up order -> appointment -> OPD token -> encounter -> patient billing lock (last).
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

    // WS2 T9: the visit charges (OPD consultation, first-visit registration), billing lock last.
    // Never blocks the check-in: an unpriced or blocked charge comes back as an outcome.
    const charges = await captureVisitChargesInTx(tx, encounter, session, now)

    return { ok: true, assignment, encounter, admissionId, completedFollowUpOrderId: order?.id ?? null, charges }
  })
}

export type TransitionEncounterResult =
  | { ok: true; encounter: Encounter; charges?: AutoChargeOutcome[] }
  | { ok: false; error: 'not_found' | 'not_owner' | 'invalid_transition' | 'admission_active' }
  | { ok: false; error: 'visit_billed'; invoiceNumber: string } // WS2 T9
  | { ok: false; error: 'visit_has_performed_orders' } // WS2 T10: a lab order of the visit is collected or later

/**
 * WS2 T9: completing an OPD visit captures its consultation if still missing (`charges`);
 * cancelling voids its consultation and lab-order lines and its registration line (WS2 T10: moved
 * to another live visit of the patient instead, when there is one), and is refused (`visit_billed`,
 * nothing changed) while one of them is on a finalised invoice. WS2 T10: cancelling also cancels the
 * visit's pending lab orders, and is refused (`visit_has_performed_orders`, nothing changed) when one
 * is collected or later. WS2 T11: cancelling also voids the visit's procedure lines and soft-voids
 * its procedures that are not coded. Lock order: follow-up orders -> encounter -> lab orders
 * (ascending id) -> their home collection visits (ascending id) -> procedures (ascending id) ->
 * patient billing lock (last).
 */
export async function transitionEncounter(
  id: number,
  to: 'in_consultation' | 'completed' | 'cancelled',
  session: Session,
  opts: { cancelReason?: string; actingProviderId?: number | null; now?: Date } = {},
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
    // WS2 T10: the visit's lab orders, then their home visits, are locked before the billing lock
    // (the lab lifecycle order: order rows, home visit, billing). A sample already taken (collected
    // or later) means the test was performed: the visit cannot be cancelled. Checked before any write.
    const pendingOrders: number[] = []
    if (to === 'cancelled') {
      const visitOrders = await tx.select({ id: labOrders.id, status: labOrders.status, homeVisitId: labOrders.homeCollectionVisitId }).from(labOrders)
        .innerJoin(labRequisitions, eq(labRequisitions.id, labOrders.requisitionId))
        .where(and(eq(labRequisitions.originatingEncounterId, id), ne(labOrders.status, 'cancelled')))
        .orderBy(asc(labOrders.id))
        .for('update', { of: labOrders })
      if (visitOrders.some((o) => !LAB_PENDING_STATUSES.includes(o.status))) return { ok: false, error: 'visit_has_performed_orders' }
      pendingOrders.push(...visitOrders.map((o) => o.id))
      // Fix round 2: the pending orders' home visits, ascending id, before voidAutoLines takes the billing lock.
      const homeVisitIds = [...new Set(visitOrders.map((o) => o.homeVisitId).filter((v): v is number => v !== null))].sort((a, b) => a - b)
      if (homeVisitIds.length > 0) {
        await tx.select({ id: homeCollectionVisits.id }).from(homeCollectionVisits)
          .where(inArray(homeCollectionVisits.id, homeVisitIds)).orderBy(asc(homeCollectionVisits.id)).for('update')
      }
    }
    // WS2 T11: the visit's live procedures, ascending id, after the home visits and before the
    // billing lock (cancelProcedure: encounter, procedure row, billing). Uncoded/proposed ones are
    // soft-voided with the visit; their lines are voided by voidAutoLinesForEncounterInTx below.
    // WS2 T12 (controller ruling): a coded live procedure was performed, like a collected sample,
    // so the cancel is refused with visit_has_performed_orders before any write.
    const proceduresToVoid: number[] = []
    if (to === 'cancelled') {
      const procs = await lockVisitProceduresInTx(tx, id)
      if (procs.some((p) => p.codingStatus === 'coded')) return { ok: false, error: 'visit_has_performed_orders' }
      proceduresToVoid.push(...procs.map((p) => p.id))
    }
    // WS2 T9: refuse the cancel before any write when a visit charge is already invoiced.
    if (to === 'cancelled') {
      const v = await voidAutoLinesForEncounterInTx(tx, id, session)
      if (!v.ok) return v
    }
    const at = opts.now ?? new Date()
    // WS2 T10 (fix round 1): the pending orders go with the visit (order-cancel semantics: a home
    // visit left with no test is cancelled; a line not voided above, e.g. one billed to a stay, is
    // voided or reported as needing a credit note).
    for (const orderId of pendingOrders) {
      const c = await cancelLabOrderInTx(tx, orderId, VISIT_CANCELLED_ORDER_REASON, session, at)
      if (!c.ok) throw new Error(`visit cancel: lab order ${orderId} ${c.error}`)
    }
    if (proceduresToVoid.length > 0) await voidVisitProceduresInTx(tx, id, current.patientId, proceduresToVoid, session, at) // WS2 T11
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
    if (to === 'completed') {
      const outcome = await ensureConsultationChargeInTx(tx, updated, session, at)
      return { ok: true, encounter: updated, charges: outcome ? [outcome] : [] }
    }
    if (to === 'cancelled') return { ok: true, encounter: updated, charges: [] }
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
