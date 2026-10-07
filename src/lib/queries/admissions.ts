import { getDb } from '@/db/client'
import { admissions, admissionTransfers, rooms, appointments, encounters } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import type { FollowUpTiming } from '@/lib/follow-ups/rules'
import { getLatestSignatureForSignable } from '@/lib/queries/signatures'
import { hasSchedulingConflict, lockProviderSchedule } from '@/lib/queries/appointments'
import { completeAdmissionEncounter } from '@/lib/queries/encounters'
import { createFollowUpOrder } from '@/lib/queries/follow-ups'

export type Admission = typeof admissions.$inferSelect

export interface CreateAdmissionInput {
  patientId: string
  roomId: number | null
  attendingProviderId: number
  admissionType: 'elective' | 'emergency' | 'transfer_in'
  createdFromAssignmentId: number | null
}

export async function createAdmission(input: CreateAdmissionInput): Promise<Admission> {
  const [created] = await getDb().insert(admissions).values({
    patientId: input.patientId,
    currentRoomId: input.roomId,
    attendingProviderId: input.attendingProviderId,
    admissionType: input.admissionType,
    createdFromAssignmentId: input.createdFromAssignmentId,
  }).returning()
  return created
}

// Only one admission can be "active" for a patient at a time -- this is how
// the check-in route (below) avoids double-admitting a patient who's already
// an inpatient. Ordered by admittedAt desc as a defensive tie-breaker; in
// practice there should only ever be zero or one matching row.
export async function getActiveAdmissionForPatient(patientId: string): Promise<Admission | null> {
  const [row] = await getDb().select().from(admissions).where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'admitted'))).orderBy(desc(admissions.admittedAt)).limit(1)
  return row ?? null
}

export async function getAdmissionById(id: number): Promise<Admission | null> {
  const [row] = await getDb().select().from(admissions).where(eq(admissions.id, id))
  return row ?? null
}

export interface ActiveAdmissionSummary {
  admissionId: number
  patientId: string
  roomLabel: string | null
  admittedAt: Date
}

// One query for every currently-admitted patient, not a per-patient
// getActiveAdmissionForPatient() call keyed off the patient dropdown -- that
// would be an N+1 against however many patients the Receive Document modal
// lists. Consumed by that modal's inline "Currently admitted — {room}" /
// "Outpatient" context (spec §6.1-6.2), which is display-only and gates
// nothing.
export async function listActiveAdmissions(): Promise<ActiveAdmissionSummary[]> {
  const rows = await getDb()
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      admittedAt: admissions.admittedAt,
      ward: rooms.ward,
      roomNumber: rooms.roomNumber,
      bedNumber: rooms.bedNumber,
    })
    .from(admissions)
    .leftJoin(rooms, eq(admissions.currentRoomId, rooms.id))
    .where(eq(admissions.status, 'admitted'))

  return rows.map((r) => ({
    admissionId: r.admissionId,
    patientId: r.patientId,
    roomLabel: r.ward !== null ? `${r.ward} ${r.roomNumber}-${r.bedNumber}` : null,
    admittedAt: r.admittedAt,
  }))
}

export interface AdmissionTransferRecord {
  id: number
  fromRoomId: number | null
  toRoomId: number
  reason: string
  transferredByName: string
  transferredAt: Date
}

export interface AdmissionWithTransfers extends Admission {
  transfers: AdmissionTransferRecord[]
  dischargeSignature: { signerTypedName: string; signedAt: Date } | null
}

// Newest admission first, each with its own transfer history (also newest
// first) -- exactly the shape the Patient Detail "Inpatient History" tab
// (Task 6) renders directly with no further reshaping.
export async function listAdmissionsForPatient(patientId: string): Promise<AdmissionWithTransfers[]> {
  const db = getDb()
  const admissionRows = await db.select().from(admissions).where(eq(admissions.patientId, patientId)).orderBy(desc(admissions.admittedAt))
  const result: AdmissionWithTransfers[] = []
  for (const admission of admissionRows) {
    const transfers = await db.select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id)).orderBy(desc(admissionTransfers.transferredAt))
    // Admitted admissions have no discharge yet -- skip the query entirely
    // rather than asking getLatestSignatureForSignable for a signature that
    // can't exist.
    const signature = admission.status === 'discharged' ? await getLatestSignatureForSignable('admission_discharge', admission.id) : null
    result.push({
      ...admission,
      transfers,
      dischargeSignature: signature ? { signerTypedName: signature.signerTypedName, signedAt: signature.signedAt } : null,
    })
  }
  return result
}

export interface TransferResult {
  ok: boolean
  error?: string
}

// Sequential, not transactional (the neon-http driver doesn't support
// multi-statement transactions -- same accepted limitation as Front Desk).
// Order matters for safety: claim the destination room FIRST (race-safe,
// conditional on it still being available), and only free the old room and
// update the admission after that succeeds. If the process died between
// steps, the failure mode is "new room occupied, old room still occupied
// too" -- an inconsistency a human can see and fix -- never "old room freed
// but nobody actually holds the new one."
export async function transferAdmission(admissionId: number, toRoomId: number, reason: string, transferredByName: string): Promise<TransferResult> {
  const db = getDb()
  const admission = await getAdmissionById(admissionId)
  if (!admission) return { ok: false, error: 'Admission not found' }
  if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }

  const claimed = await db.update(rooms).set({ status: 'occupied', occupiedByPatientId: admission.patientId }).where(and(eq(rooms.id, toRoomId), eq(rooms.status, 'available'))).returning({ id: rooms.id })
  if (claimed.length === 0) return { ok: false, error: 'That room is no longer available. Please choose another.' }

  const fromRoomId = admission.currentRoomId
  if (fromRoomId !== null) {
    await db.update(rooms).set({ status: 'dirty', occupiedByPatientId: null }).where(eq(rooms.id, fromRoomId))
  }

  await db.update(admissions).set({ currentRoomId: toRoomId }).where(eq(admissions.id, admissionId))
  await db.insert(admissionTransfers).values({ admissionId, fromRoomId, toRoomId, reason, transferredByName })

  return { ok: true }
}

export interface DischargeFollowUpPlan {
  timing: FollowUpTiming
  windowDaysBefore?: number
  windowDaysAfter?: number
  reason: string
  planNotes: string | null
}

export interface DischargeInput {
  dischargeDiagnosis: string
  dischargeDrugs: string
  dischargeDevices: string
  dischargeDiet: string
  dischargeSummaryNotes: string
  /** A booked follow-up slot with the attending provider. */
  followUp: { startsAt: Date; endsAt: Date } | null
  /** SP3: the clinical follow-up plan (becomes a `discharge` follow-up order). */
  followUpPlan: DischargeFollowUpPlan | null
}

export const DISCHARGE_FOLLOW_UP_REASON = 'Post-discharge follow-up'

export interface DischargeResult {
  ok: boolean
  /**
   * 'Admission not found' | 'This admission has already been discharged' (legacy
   * display strings), or the SP3 codes 'conflict' (the slot is taken),
   * 'due_date_invalid' (fixed `message`) and 'provider_not_found' (the
   * attending doctor is inactive, so no follow-up can be prescribed).
   */
  error?: string
  message?: string
  followUpAppointmentId?: number
  followUpOrderId?: number
  followUpDueDate?: string
}

/** Thrown inside the transaction to roll it back; mapped to a result outside. */
class DischargeRollback extends Error {
  constructor(readonly result: DischargeResult) {
    super('discharge rolled back')
  }
}

/**
 * Discharges the admission as ONE transaction (node-postgres supports real
 * transactions; the old "sequential, not transactional" posture is gone):
 *
 * 1. Lock the admission row `for update` and check it is still admitted.
 * 2. Store the five Ds and the discharge fields; free the room to `dirty`.
 * 3. With a slot: take the per-provider booking lock (the same key as
 *    bookFollowUp), run the conflict check on the tx, insert the appointment
 *    and link it as `followUpAppointmentId`.
 * 4. With a plan or a slot: create the `discharge` follow-up order on the tx
 *    (`scheduled` when a slot was booked, else `planned`). Interval plans count
 *    from the discharge day (IST), not the admission day.
 * 5. Close the admission's open IPD encounter.
 * 6. Audit `discharged patient` (ids only) on the tx.
 *
 * Any failure (conflict, invalid due date, a thrown DB error) rolls back
 * every step, so the room, the admission and the calendar stay untouched.
 */
export async function dischargeAdmission(admissionId: number, input: DischargeInput, session: Session): Promise<DischargeResult> {
  try {
    return await getDb().transaction(async (tx): Promise<DischargeResult> => {
      // 1.
      const [admission] = await tx.select().from(admissions).where(eq(admissions.id, admissionId)).for('update')
      if (!admission) return { ok: false, error: 'Admission not found' }
      if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }

      // 2.
      const dischargedAt = new Date()
      await tx.update(admissions).set({
        status: 'discharged',
        dischargedAt,
        currentRoomId: null,
        dischargeDiagnosis: input.dischargeDiagnosis,
        dischargeDrugs: input.dischargeDrugs,
        dischargeDevices: input.dischargeDevices,
        dischargeDiet: input.dischargeDiet,
        dischargeSummaryNotes: input.dischargeSummaryNotes,
      }).where(eq(admissions.id, admissionId))

      if (admission.currentRoomId !== null) {
        await tx.update(rooms).set({ status: 'dirty', occupiedByPatientId: null }).where(eq(rooms.id, admission.currentRoomId))
      }

      // 3.
      let followUpAppointmentId: number | undefined
      if (input.followUp) {
        const providerId = admission.attendingProviderId
        await lockProviderSchedule(tx, providerId)
        if (await hasSchedulingConflict(providerId, input.followUp.startsAt, input.followUp.endsAt, undefined, tx)) {
          throw new DischargeRollback({ ok: false, error: 'conflict' })
        }
        const [appt] = await tx.insert(appointments).values({
          patientId: admission.patientId,
          providerId,
          startsAt: input.followUp.startsAt,
          endsAt: input.followUp.endsAt,
          visitReason: DISCHARGE_FOLLOW_UP_REASON,
          status: 'scheduled',
        }).returning({ id: appointments.id })
        followUpAppointmentId = appt.id
        await tx.update(admissions).set({ followUpAppointmentId: appt.id }).where(eq(admissions.id, admissionId))
      }

      // 4.
      let followUpOrderId: number | undefined
      let followUpDueDate: string | undefined
      if (input.followUpPlan || input.followUp) {
        const today = istDateOf(dischargedAt)
        const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.admissionId, admissionId))
        const plan = input.followUpPlan
        const created = await createFollowUpOrder({
          patientId: admission.patientId,
          source: 'discharge',
          prescribedByProviderId: admission.attendingProviderId,
          departmentId: null,
          timing: plan ? plan.timing : { kind: 'date', dueDate: istDateOf(input.followUp!.startsAt) },
          windowDaysBefore: plan?.windowDaysBefore,
          windowDaysAfter: plan?.windowDaysAfter,
          reason: plan ? plan.reason : DISCHARGE_FOLLOW_UP_REASON,
          planNotes: plan ? plan.planNotes : null,
          originatingEncounterId: encounter?.id ?? null,
          originatingAdmissionId: admissionId,
          appointmentId: followUpAppointmentId ?? null,
        }, session, { executor: tx, today, baseDate: today })
        if (!created.ok) {
          if (created.error === 'due_date_invalid') throw new DischargeRollback({ ok: false, error: 'due_date_invalid', message: created.message })
          if (created.error === 'provider_not_found') throw new DischargeRollback({ ok: false, error: 'provider_not_found' })
          throw new Error(`follow-up order not created: ${created.error}`)
        }
        followUpOrderId = created.order.id
        followUpDueDate = created.order.dueDate
      }

      // 5.
      await completeAdmissionEncounter(tx, admissionId, session.name)

      // 6. Ids only.
      await logAudit(session, 'discharged patient', admission.patientId, `admission=${admissionId}`, tx)

      return { ok: true, followUpAppointmentId, followUpOrderId, followUpDueDate }
    })
  } catch (err) {
    if (err instanceof DischargeRollback) return err.result
    throw err
  }
}
