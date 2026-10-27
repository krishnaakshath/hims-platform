// WS3 T2: the one admission path (spec 3.1 items 1-11). POST /api/inpatient/admissions calls it;
// front-desk check-in no longer admits.
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, codeSystems, codes, diagnoses, doctorAssignments, encounters, patients, preauths,
  providers, rooms,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { ageOnDate, istDateOf } from '@/lib/india-time'
import { wardGenderConflict, type WardGenderConflict } from '@/lib/inpatient/admission-rules'
import type { AdmitPatientRequest } from '@/lib/inpatient/validation'
import type { AdmissionCoverageMode, CoverageVerdict } from '@/lib/insurance/coverage'
import { CLOSED_PREAUTH_STATUSES, checkAdmissionCoverage, upsertAdmissionCoverage } from './admission-coverage'
import { ensureConsultationChargeInTx } from './auto-charge'
import { lockPatientBilling } from './billing-lock'
import { refusesSampleCodes } from './coding'
import type { WriteExecutor } from './executor'

/** The admission request with `patientId` already resolved to the chart id by the caller. */
export type AdmitPatientInput = AdmitPatientRequest

export type AdmitPatientError =
  | 'patient_not_found' | 'provider_not_found' | 'room_unavailable' | 'already_admitted' | 'ward_gender_conflict' | 'open_opd_visit'
  | 'policy_mismatch' | 'preauth_mismatch' | 'preauth_closed' | 'coverage_blocked' | 'code_not_found'

export type AdmitPatientResult =
  | { ok: true; admissionId: number; encounterId: number; roomLabel: string; coverage: CoverageVerdict; coverageMode: AdmissionCoverageMode }
  | { ok: false; error: AdmitPatientError; conflict?: WardGenderConflict; openEncounterId?: number; coverage?: CoverageVerdict }

type Refusal = Extract<AdmitPatientResult, { ok: false }>

// Thrown inside the transaction so a refusal after any write (the bed claim) rolls it all back.
class AdmitRefusal extends Error {
  constructor(readonly result: Refusal) { super(result.error) }
}
function refuse(error: AdmitPatientError, extra: Omit<Refusal, 'ok' | 'error'> = {}): never {
  throw new AdmitRefusal({ ok: false, error, ...extra })
}

const OPEN_OPD_STATUSES = ['checked_in', 'in_consultation'] as const

export interface AdmissionCoverageSeamInput {
  admissionId: number
  patientId: string
  mode: AdmissionCoverageMode
  policyId: number | null
  preauthId: number | null
  depositRequiredPaise: number
}

/** The payment mode of an admission request: as chosen, else cashless with a policy and self-pay without. */
export function admissionCoverageMode(input: Pick<AdmitPatientInput, 'coverageMode' | 'policyId'>): AdmissionCoverageMode {
  return input.coverageMode ?? (input.policyId !== null ? 'cashless' : 'self_pay')
}

/**
 * WS12 Task 9 hook (lane ruling R3): the ONE place an admission's payer, pre-auth and deposit are
 * persisted, in WS12's `admission_coverage` row, with the verdict admitInTx computed by
 * checkAdmissionCoverage BEFORE the bed claim (any coverage refusal happens there, so nothing
 * here refuses). Runs on the caller's transaction.
 */
export async function recordAdmissionCoverageInTx(tx: WriteExecutor, input: AdmissionCoverageSeamInput, verdict: CoverageVerdict, session: Session, now: Date): Promise<void> {
  await upsertAdmissionCoverage(tx, input.admissionId, input.patientId, {
    mode: input.mode, policyId: input.policyId, preauthId: input.preauthId, depositRequiredPaise: input.depositRequiredPaise,
  }, verdict, session, now)
}

/**
 * Admits a patient as ONE transaction. Lock order: the per-patient advisory lock
 * (`admissions.patient:<id>`, which serialises every admission of the patient) -> the room row ->
 * the patient's open OPD encounters of today (ascending id) -> the patient billing lock (only when
 * an open OPD visit is completed -- its consultation charge, as transitionEncounter does -- or a
 * pre-auth is linked) -> the pre-auth row (SP7's billing-lock-then-row order).
 * WS12 T9: the payer, pre-auth and cover are checked (reads only) before the bed claim; a cashless
 * stay whose cover blocks (R4: expired, not started, inactive, insurer says not in force) is
 * refused as `coverage_blocked` unless the admission is an emergency.
 * Refusals are returned with nothing written; the partial unique index
 * `admissions_one_active_per_patient` is the backstop and maps to `already_admitted`.
 * `now` is the admission instant; "today" is its IST date.
 */
export async function admitPatient(input: AdmitPatientInput, session: Session, now: Date = new Date()): Promise<AdmitPatientResult> {
  try {
    return await getDb().transaction(async (tx) => admitInTx(tx, input, session, now))
  } catch (err) {
    if (err instanceof AdmitRefusal) return err.result
    if (isUniqueViolation(err, 'admissions_one_active_per_patient')) return { ok: false, error: 'already_admitted' }
    throw err
  }
}

async function admitInTx(tx: WriteExecutor, input: AdmitPatientInput, session: Session, now: Date): Promise<AdmitPatientResult> {
  const today = istDateOf(now)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`admissions.patient:${input.patientId}`}))`)

  const [patient] = await tx.select({ id: patients.id, gender: patients.gender, dob: patients.dob }).from(patients).where(eq(patients.id, input.patientId))
  if (!patient) refuse('patient_not_found')
  const [provider] = await tx.select({ id: providers.id, departmentId: providers.departmentId }).from(providers).where(eq(providers.id, input.attendingProviderId))
  if (!provider) refuse('provider_not_found')
  const [active] = await tx.select({ id: admissions.id }).from(admissions)
    .where(and(eq(admissions.patientId, patient.id), eq(admissions.status, 'admitted'))).limit(1)
  if (active) refuse('already_admitted')

  const [room] = await tx.select().from(rooms).where(eq(rooms.id, input.roomId)).for('update')
  if (!room || room.status !== 'available') refuse('room_unavailable')
  const conflict = wardGenderConflict({ patientGender: patient.gender ?? null, ageYears: ageOnDate(patient.dob, today), ward: room.genderRestriction ?? null })
  if (conflict && input.wardGenderOverrideReason === null) refuse('ward_gender_conflict', { conflict })

  const openOpd = await tx.select({ id: encounters.id }).from(encounters)
    .where(and(eq(encounters.patientId, patient.id), eq(encounters.encounterType, 'opd'), eq(encounters.encounterDate, today), inArray(encounters.status, [...OPEN_OPD_STATUSES])))
    .orderBy(asc(encounters.id))
    .for('update')
  if (openOpd.length > 0 && input.openOpdVisit === null) refuse('open_opd_visit', { openEncounterId: openOpd[0].id })

  // WS12 T9: the payer, pre-auth and cover, before the bed claim (reads only).
  const mode = admissionCoverageMode(input)
  const coverage = await checkAdmissionCoverage(tx, {
    patientId: patient.id,
    input: { mode, policyId: input.policyId, preauthId: input.preauthId },
    emergency: input.admissionType === 'emergency',
  }, now)
  if (!coverage.ok) refuse(coverage.error, coverage.verdict ? { coverage: coverage.verdict } : {})

  // Claim the bed (re-checked at write time). From here on a refusal rolls the claim back.
  const claimed = await tx.update(rooms).set({ status: 'occupied', occupiedByPatientId: patient.id })
    .where(and(eq(rooms.id, room.id), eq(rooms.status, 'available'))).returning({ id: rooms.id })
  if (claimed.length === 0) refuse('room_unavailable')

  let code: { id: number; code: string; display: string } | null = null
  if ('codeId' in input.provisionalDiagnosis) {
    // The WHO ICD-10 picker's codes: the current, non-sample ICD-10 version (as the doctor's workspace).
    const [c] = await tx.select({ id: codes.id, code: codes.code, display: codes.display, active: codes.active, isSample: codeSystems.isSample })
      .from(codes).innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
      .where(and(eq(codes.id, input.provisionalDiagnosis.codeId), eq(codeSystems.kind, 'icd10'), eq(codeSystems.isCurrent, true)))
    if (!c || !c.active || (c.isSample && refusesSampleCodes())) refuse('code_not_found')
    code = { id: c.id, code: c.code, display: c.display }
  }

  // The doctor's inpatient assignment: no lobby ticket (0; the queue display skips <= 0).
  const [assignment] = await tx.insert(doctorAssignments).values({
    patientId: patient.id,
    providerId: provider.id,
    visitType: 'inpatient',
    urgency: input.admissionType === 'emergency' ? 'emergency' : 'routine',
    reason: input.reason,
    status: 'scheduled',
    roomId: room.id,
    assignedByName: session.name,
    queueTicketNumber: 0,
    createdAt: now,
  }).returning({ id: doctorAssignments.id })

  const override = conflict !== null
  const [admission] = await tx.insert(admissions).values({
    patientId: patient.id,
    currentRoomId: room.id,
    attendingProviderId: provider.id,
    admissionType: input.admissionType,
    admittedAt: now,
    createdFromAssignmentId: assignment.id,
    expectedStayDays: input.expectedStayDays,
    attendantName: input.attendant?.name ?? null,
    attendantRelationship: input.attendant?.relationship ?? null,
    attendantPhone: input.attendant?.phone ?? null,
    wardGenderOverrideReason: override ? input.wardGenderOverrideReason : null,
    wardGenderOverrideByName: override ? session.name : null,
    admittedByName: session.name,
  }).returning({ id: admissions.id })

  // The IPD encounter: no OPD token (spec 3.1 item 6).
  const [encounter] = await tx.insert(encounters).values({
    patientId: patient.id,
    encounterType: 'ipd',
    visitType: input.admissionType === 'emergency' ? 'emergency' : 'new',
    status: 'checked_in',
    encounterDate: today,
    opdToken: null,
    departmentId: provider.departmentId ?? null,
    providerId: provider.id,
    admissionId: admission.id,
    doctorAssignmentId: assignment.id,
    checkedInByName: session.name,
    checkedInAt: now,
  }).returning({ id: encounters.id })

  await tx.insert(diagnoses).values({
    patientId: patient.id,
    code: code?.code ?? '',
    description: code?.display ?? ('text' in input.provisionalDiagnosis ? input.provisionalDiagnosis.text : ''),
    date: today,
    encounterId: encounter.id,
    codeId: code?.id ?? null,
    codeSystemKind: code ? 'icd10' : null,
    codeDisplay: code?.display ?? null,
    diagnosisType: 'provisional',
    codingStatus: code ? 'proposed' : 'uncoded',
    proposedByName: code ? session.name : null,
    proposedAt: code ? now : null,
    createdByName: session.name,
    createdAt: now,
  })

  // Open OPD visit: 'complete' closes it here with a direct status update on the rows locked above
  // (transitionEncounter opens its own transaction, which would wait on these very row locks), then
  // captures its consultation if still missing exactly as transitionEncounter's completion does.
  // That capture takes the patient billing lock, after every clinical row lock.
  if (input.openOpdVisit === 'complete') {
    for (const o of openOpd) {
      const [done] = await tx.update(encounters)
        .set({ status: 'completed', completedAt: now, statusChangedAt: now, statusChangedByName: session.name })
        .where(eq(encounters.id, o.id)).returning()
      await logAudit(session, 'completed OPD visit at admission', patient.id, `encounter=${o.id} admission=${admission.id}`, tx)
      await ensureConsultationChargeInTx(tx, done, session, now)
    }
  }

  if (input.preauthId !== null) {
    // SP7: every pre-auth write takes the patient billing lock first, then the pre-auth row
    // (re-entrant when the OPD completion above already holds it).
    await lockPatientBilling(tx, patient.id)
    const linked = await tx.update(preauths).set({ admissionId: admission.id, updatedAt: now })
      .where(and(eq(preauths.id, input.preauthId), isNull(preauths.admissionId), notInArray(preauths.status, [...CLOSED_PREAUTH_STATUSES])))
      .returning({ id: preauths.id })
    if (linked.length === 0) refuse('preauth_mismatch')
  }

  await recordAdmissionCoverageInTx(tx, {
    admissionId: admission.id, patientId: patient.id, mode, policyId: input.policyId, preauthId: input.preauthId, depositRequiredPaise: input.depositRequiredPaise,
  }, coverage.verdict, session, now)

  // Ids only -- never the reason, diagnosis, attendant or override text.
  await logAudit(session, 'admitted patient', patient.id, `admission=${admission.id} room=${room.id}`, tx)
  if (override) await logAudit(session, 'ward gender override', patient.id, `admission=${admission.id} room=${room.id}`, tx)
  if (input.preauthId !== null) await logAudit(session, 'linked pre-auth at admission', patient.id, `preauth=${input.preauthId} admission=${admission.id}`, tx)

  return { ok: true, admissionId: admission.id, encounterId: encounter.id, roomLabel: `${room.ward} ${room.roomNumber}-${room.bedNumber}`, coverage: coverage.verdict, coverageMode: mode }
}
