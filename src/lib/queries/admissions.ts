import { getDb } from '@/db/client'
import { admissions, admissionTransfers, rooms, appointments, encounters, patients, diagnoses } from '@/db/schema'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { ageOnDate, istDateOf } from '@/lib/india-time'
import { wardGenderConflict, type WardGenderConflict } from '@/lib/inpatient/admission-rules'
import type { FollowUpTiming } from '@/lib/follow-ups/rules'
import { getLatestSignatureForSignable } from '@/lib/queries/signatures'
import { hasSchedulingConflict, lockProviderSchedule } from '@/lib/queries/appointments'
import { completeAdmissionEncounter } from '@/lib/queries/encounters'
import { createFollowUpOrder } from '@/lib/queries/follow-ups'
import { loadAdmissionDues } from '@/lib/queries/admission-dues' // WS3 T5
import { lockPatientBilling } from '@/lib/queries/billing-lock' // WS3 T5
import { clearanceIsCurrent, type DischargeDues } from '@/lib/inpatient/dues' // WS3 T5
import { addEncounterDiagnosisInTx, lockEncounterCoding } from '@/lib/queries/coding' // WS3 T6
import type { WriteExecutor } from '@/lib/queries/executor' // WS3 T6

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
  /**
   * 'Admission not found' | 'This admission has already been discharged' | the room-unavailable
   * message (legacy display strings), or WS3 T4's 'ward_gender_conflict' (with `conflict`).
   */
  error?: string
  conflict?: WardGenderConflict
  /** True when the move was made under a ward-gender override (the caller audits it, ids only). */
  wardGenderOverride?: boolean
}

export interface TransferOptions {
  /** Required (10..300 chars, validated by the route) when the destination bed conflicts; ignored otherwise. */
  wardGenderOverrideReason?: string | null
  now?: Date
}

class TransferRefusal extends Error {
  constructor(readonly result: TransferResult) { super('transfer refused') }
}

const ROOM_UNAVAILABLE = 'That room is no longer available. Please choose another.'

// ONE transaction (node-postgres): lock the admission row, then the destination room row; apply the
// ward-gender rule (spec 3.1 item 10, the admission rule: children under 12 exempt, age on the IST
// date of `now`); claim the destination (re-checked `status = 'available'` at write time), free the
// old room to `dirty`, move the admission and record the transfer -- the override reason, when used,
// on the transfer row (the overrider is `transferredByName`). Any refusal writes nothing.
export async function transferAdmission(admissionId: number, toRoomId: number, reason: string, transferredByName: string, opts: TransferOptions = {}): Promise<TransferResult> {
  const now = opts.now ?? new Date()
  try {
    return await getDb().transaction(async (tx): Promise<TransferResult> => {
      const [admission] = await tx.select().from(admissions).where(eq(admissions.id, admissionId)).for('update')
      if (!admission) return { ok: false, error: 'Admission not found' }
      if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }

      const [room] = await tx.select({ id: rooms.id, status: rooms.status, genderRestriction: rooms.genderRestriction }).from(rooms).where(eq(rooms.id, toRoomId)).for('update')
      if (!room || room.status !== 'available') return { ok: false, error: ROOM_UNAVAILABLE }

      const [patient] = await tx.select({ gender: patients.gender, dob: patients.dob }).from(patients).where(eq(patients.id, admission.patientId))
      const conflict = wardGenderConflict({
        patientGender: patient?.gender ?? null, ageYears: patient ? ageOnDate(patient.dob, istDateOf(now)) : 0, ward: room.genderRestriction ?? null,
      })
      const overrideReason = opts.wardGenderOverrideReason ?? null
      if (conflict && overrideReason === null) return { ok: false, error: 'ward_gender_conflict', conflict }

      const claimed = await tx.update(rooms).set({ status: 'occupied', occupiedByPatientId: admission.patientId })
        .where(and(eq(rooms.id, toRoomId), eq(rooms.status, 'available'))).returning({ id: rooms.id })
      if (claimed.length === 0) throw new TransferRefusal({ ok: false, error: ROOM_UNAVAILABLE })

      const fromRoomId = admission.currentRoomId
      if (fromRoomId !== null) {
        await tx.update(rooms).set({ status: 'dirty', occupiedByPatientId: null }).where(eq(rooms.id, fromRoomId))
      }

      await tx.update(admissions).set({ currentRoomId: toRoomId }).where(eq(admissions.id, admissionId))
      await tx.insert(admissionTransfers).values({
        admissionId, fromRoomId, toRoomId, reason, transferredByName, transferredAt: now,
        wardGenderOverrideReason: conflict ? overrideReason : null,
      })
      return { ok: true, wardGenderOverride: conflict !== null }
    })
  } catch (err) {
    if (err instanceof TransferRefusal) return err.result
    throw err
  }
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
  /**
   * WS3 T6: the discharge ICD-10 codes (at most 5, unique), first = primary, rest secondary,
   * written as `proposed` diagnoses on the IPD encounter. Omitted / [] writes none.
   */
  diagnosisCodeIds?: number[]
}

/** WS3 T6: refusals of the coded discharge diagnoses (the whole discharge rolls back). */
export type DischargeDiagnosisError = 'code_not_found' | 'code_not_current' | 'code_not_valid_for_patient' | 'coding_locked' | 'no_ipd_encounter'

export const DISCHARGE_FOLLOW_UP_REASON = 'Post-discharge follow-up'

export interface DischargeResult {
  ok: boolean
  /**
   * 'Admission not found' | 'This admission has already been discharged' (legacy
   * display strings), or the SP3 codes 'conflict' (the slot is taken),
   * 'slot_in_past' (the slot is not later than now),
   * 'due_date_invalid' (fixed `message`) and 'provider_not_found' (the
   * attending doctor is inactive, so no follow-up can be prescribed),
   * WS3 T5: 'dues_outstanding' (with `dues`).
   * WS3 T6: a DischargeDiagnosisError (nothing was written).
   */
  error?: string
  message?: string
  dues?: DischargeDues // WS3 T5
  followUpAppointmentId?: number
  followUpOrderId?: number
  followUpDueDate?: string
}

/**
 * WS3 T6: writes the discharge codes as SP6 diagnoses on the IPD encounter, under the encounter's
 * coding lock. A code already live on the encounter as primary/secondary is not written twice (the
 * dialog pre-fills the stay's codes); the first NEW code is `primary` unless a live primary
 * exists, every other one `secondary`. A provisional row stays as it is (the provisional and the
 * final diagnosis are separate facts). Any refusal throws DischargeRollback.
 */
async function writeDischargeDiagnoses(tx: WriteExecutor, encounterId: number, codeIds: number[], session: Session, now: Date): Promise<void> {
  await lockEncounterCoding(tx, encounterId)
  const live = await tx.select({ codeId: diagnoses.codeId, type: diagnoses.diagnosisType }).from(diagnoses)
    .where(and(eq(diagnoses.encounterId, encounterId), isNull(diagnoses.voidedAt), inArray(diagnoses.diagnosisType, ['primary', 'secondary'])))
  const recorded = new Set(live.map((d) => d.codeId).filter((id): id is number => id !== null))
  let primaryTaken = live.some((d) => d.type === 'primary')
  for (const codeId of codeIds) {
    if (recorded.has(codeId)) continue
    const type = primaryTaken ? 'secondary' : 'primary'
    primaryTaken = true
    const r = await addEncounterDiagnosisInTx(tx, encounterId, { type, codeId }, session, now, { asDoctor: true, currentIcd10Version: true })
    if (r.ok) continue
    throw new DischargeRollback({ ok: false, error: dischargeDiagnosisError(r.error, r.issues?.map((i) => i.code) ?? []) })
  }
}

function dischargeDiagnosisError(error: string, issueCodes: string[]): DischargeDiagnosisError {
  switch (error) {
    case 'code_not_found': return 'code_not_found'
    case 'code_not_current':
    case 'sample_code': return 'code_not_current'
    case 'code_invalid': return issueCodes.some((c) => c === 'sex_mismatch' || c === 'age_out_of_range') ? 'code_not_valid_for_patient' : 'code_not_current'
    case 'locked': return 'coding_locked'
    case 'not_found':
    case 'encounter_cancelled': return 'no_ipd_encounter'
    // primary_exists cannot happen: the live rows were read under the coding lock held here.
    default: throw new Error(`unexpected coding outcome ${error}`)
  }
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
 *    Lock order (WS3 T5/T6): the admission's IPD encounter row FOR UPDATE, then the patient's
 *    billing lock, then the admission row, then the room, then (T6) the encounter's coding row.
 *    The encounter goes first because orderProcedure/cancelProcedure hold it FOR SHARE before
 *    they take the billing lock; taking billing first here would let the two cycle (40P01).
 *    The billing lock means no charge or payment lands between the dues check and the commit.
 *    Then the dues gate: outstanding dues refuse the discharge (`dues_outstanding`) unless
 *    billing's latest clearance is still current (clearanceIsCurrent). The only discharge dues gate.
 * 2. Store the five Ds and the discharge fields; free the room to `dirty`.
 *    WS3 T6: then write the coded discharge diagnoses through SP6 (addEncounterDiagnosisInTx, as
 *    the doctor: `proposed`, current ICD-10 only). A refused code rolls back the whole discharge.
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
      const [pre] = await tx.select({ patientId: admissions.patientId }).from(admissions).where(eq(admissions.id, admissionId)).limit(1) // WS3 T5
      if (!pre) return { ok: false, error: 'Admission not found' } // WS3 T5
      // WS3 T6: the IPD encounter row first (global lock order I1: encounter -> billing).
      const [ipdEncounter] = await tx.select({ id: encounters.id }).from(encounters)
        .where(and(eq(encounters.admissionId, admissionId), eq(encounters.encounterType, 'ipd'))).for('update')
      await lockPatientBilling(tx, pre.patientId) // WS3 T5
      const [admission] = await tx.select().from(admissions).where(eq(admissions.id, admissionId)).for('update')
      if (!admission) return { ok: false, error: 'Admission not found' }
      if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }
      // WS3 T5: the dues gate (nothing has been written yet, so returning commits nothing).
      const loaded = await loadAdmissionDues(admissionId, tx)
      if (loaded && loaded.dues.outstandingPaise > 0 && !clearanceIsCurrent(loaded.latestClearance, loaded.dues)) {
        return { ok: false, error: 'dues_outstanding', dues: loaded.dues }
      }

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

      // WS3 T6: the coded discharge diagnoses (after the gate, inside the discharge).
      const codeIds = input.diagnosisCodeIds ?? []
      if (codeIds.length > 0) {
        if (!ipdEncounter) throw new DischargeRollback({ ok: false, error: 'no_ipd_encounter' })
        await writeDischargeDiagnoses(tx, ipdEncounter.id, codeIds, session, dischargedAt)
      }

      // 3.
      let followUpAppointmentId: number | undefined
      if (input.followUp) {
        const providerId = admission.attendingProviderId
        // M10: the same rule as bookFollowUp -- a follow-up slot must be later than now.
        if (input.followUp.startsAt.getTime() <= dischargedAt.getTime()) throw new DischargeRollback({ ok: false, error: 'slot_in_past' })
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
