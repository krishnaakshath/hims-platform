import { getDb } from '@/db/client'
import { admissions, admissionTransfers, rooms, appointments } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { getLatestSignatureForSignable } from '@/lib/queries/signatures'

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

export interface DischargeInput {
  dischargeDiagnosis: string
  dischargeDrugs: string
  dischargeDevices: string
  dischargeDiet: string
  dischargeSummaryNotes: string
  followUp: { startsAt: Date; endsAt: Date } | null
}

export interface DischargeResult {
  ok: boolean
  error?: string
  followUpAppointmentId?: number
}

// Sequential, not transactional -- same driver limitation noted on
// transferAdmission. Order: mark the admission discharged FIRST (the
// single authoritative state change), then free the room, then create the
// optional follow-up appointment. If the process dies after the first step,
// the admission is correctly discharged and only the room-freeing or
// appointment-creation is left incomplete -- a visible, fixable state, never
// a room silently left occupied by a patient the record says already left,
// or a "successful" discharge that silently kept the room occupied.
export async function dischargeAdmission(admissionId: number, input: DischargeInput): Promise<DischargeResult> {
  const db = getDb()
  const admission = await getAdmissionById(admissionId)
  if (!admission) return { ok: false, error: 'Admission not found' }
  if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }

  await db.update(admissions).set({
    status: 'discharged',
    dischargedAt: new Date(),
    currentRoomId: null,
    dischargeDiagnosis: input.dischargeDiagnosis,
    dischargeDrugs: input.dischargeDrugs,
    dischargeDevices: input.dischargeDevices,
    dischargeDiet: input.dischargeDiet,
    dischargeSummaryNotes: input.dischargeSummaryNotes,
  }).where(eq(admissions.id, admissionId))

  if (admission.currentRoomId !== null) {
    await db.update(rooms).set({ status: 'dirty', occupiedByPatientId: null }).where(eq(rooms.id, admission.currentRoomId))
  }

  let followUpAppointmentId: number | undefined
  if (input.followUp) {
    const [appt] = await db.insert(appointments).values({
      patientId: admission.patientId,
      providerId: admission.attendingProviderId,
      startsAt: input.followUp.startsAt,
      endsAt: input.followUp.endsAt,
      visitReason: 'Post-discharge follow-up',
      status: 'scheduled',
    }).returning()
    followUpAppointmentId = appt.id
    await db.update(admissions).set({ followUpAppointmentId: appt.id }).where(eq(admissions.id, admissionId))
  }

  return { ok: true, followUpAppointmentId }
}
