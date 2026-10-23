// WS1 T3: the consultation workspace read model (/encounters/[id]), the explicit "start
// consultation" step, and the doctor-home helpers that link today's schedule to its visits.
// Reading never mutates: only startConsultation (POST .../start) moves a visit on.
import { and, asc, desc, eq, gte, inArray, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/db/client'
import {
  admissions, departments, diagnoses, encounterConsults, encounterNotes, encounterVitals, encounters, patientPolicies, patients, payers, providers,
  type EncounterConsultRow, type EncounterRow, type EncounterVitalsRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { CLINICAL_WRITE_ROLES, VITALS_ROLES } from '@/lib/role-policy'
import type { EncounterStatus, EncounterType, EncounterVisitType } from '@/lib/encounters/status'
import { bmiTenths, vitalsFlags, type VitalsFlag } from '@/lib/encounters/vitals'
import { ageOnDate, todayIsoIn } from '@/lib/india-time'
import type { PatientRow } from '@/components/PatientsTable'
import { getConsult, listVitals, priorConsults, type PriorConsult } from './encounter-clinical'
import { getEncounterById, transitionEncounter } from './encounters'
import { listActiveAllergies } from './allergies'
import { liveDiagnosis } from './diagnoses'

export type WorkspaceAlert = 'allergy_status_unknown' | 'currently_admitted'

export interface WorkspaceView {
  encounter: { id: number; status: EncounterStatus; encounterType: EncounterType; visitType: EncounterVisitType; encounterDate: string; opdToken: number | null; departmentName: string | null; providerId: number; providerName: string; checkedInAt: Date }
  patient: {
    id: string; uhid: string | null; name: string; ageYears: number | null; sex: string | null; phone: string | null; payerName: string | null
    allergyStatus: 'unknown' | 'none_known' | 'recorded'; allergies: { id: number; allergen: string; reaction: string | null; severity: 'mild' | 'moderate' | 'severe' }[]
    alerts: WorkspaceAlert[]
  }
  vitals: (EncounterVitalsRow & { bmiTenths: number | null; flags: VitalsFlag[] })[]
  consult: EncounterConsultRow | null
  history: PriorConsult[]
  canWrite: boolean
  canRecordVitals: boolean
}

const isOpen = (s: EncounterStatus) => s === 'checked_in' || s === 'in_consultation'

async function primaryPayerName(patientId: string): Promise<string | null> {
  const rows = await getDb().select({ name: payers.name }).from(patientPolicies)
    .innerJoin(payers, eq(payers.id, patientPolicies.insurerPayerId))
    .where(and(eq(patientPolicies.patientId, patientId), eq(patientPolicies.priority, 'primary'), eq(patientPolicies.status, 'active')))
    .orderBy(desc(patientPolicies.id)).limit(1)
  return rows[0]?.name ?? null
}

export async function getWorkspace(encounterId: number, session: Session): Promise<WorkspaceView | null> {
  const db = getDb()
  const [e] = await db.select({
    id: encounters.id, status: encounters.status, encounterType: encounters.encounterType, visitType: encounters.visitType,
    encounterDate: encounters.encounterDate, opdToken: encounters.opdToken, departmentName: departments.name,
    providerId: encounters.providerId, providerName: providers.name, checkedInAt: encounters.checkedInAt, patientId: encounters.patientId,
  }).from(encounters)
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .where(eq(encounters.id, encounterId))
  if (!e) return null

  const [p] = await db.select({
    id: patients.id, uhid: patients.uhid, name: patients.name, dob: patients.dob, gender: patients.gender, phone: patients.phone, allergyStatus: patients.allergyStatus,
  }).from(patients).where(eq(patients.id, e.patientId))
  if (!p) return null

  const [payerName, activeAllergies, [admitted], vitals, consult, history] = await Promise.all([
    primaryPayerName(p.id),
    listActiveAllergies(p.id),
    db.select({ id: admissions.id }).from(admissions).where(and(eq(admissions.patientId, p.id), eq(admissions.status, 'admitted'))).limit(1),
    listVitals(encounterId),
    getConsult(encounterId),
    priorConsults(p.id, encounterId),
  ])

  const alerts: WorkspaceAlert[] = []
  if (p.allergyStatus === 'unknown') alerts.push('allergy_status_unknown')
  if (admitted) alerts.push('currently_admitted')

  // Ownership mirrors checkEncounterWriter: admin any visit, pi only their own, crc vitals only.
  const open = isOpen(e.status)
  let own = session.role === 'admin'
  if (session.role === 'pi') own = (await resolveDoctorQueueProvider(session))?.id === e.providerId
  const canWrite = open && CLINICAL_WRITE_ROLES.includes(session.role) && own
  const canRecordVitals = open && VITALS_ROLES.includes(session.role) && (session.role === 'crc' || own)

  return {
    encounter: {
      id: e.id, status: e.status, encounterType: e.encounterType, visitType: e.visitType, encounterDate: e.encounterDate, opdToken: e.opdToken,
      departmentName: e.departmentName, providerId: e.providerId, providerName: e.providerName, checkedInAt: e.checkedInAt,
    },
    patient: {
      id: p.id, uhid: p.uhid, name: p.name,
      ageYears: p.dob ? ageOnDate(String(p.dob), todayIsoIn()) : null,
      sex: p.gender ?? null, phone: p.phone, payerName,
      allergyStatus: p.allergyStatus,
      allergies: activeAllergies.map((a) => ({ id: a.id, allergen: a.allergen, reaction: a.reaction, severity: a.severity })),
      alerts,
    },
    vitals: vitals.map((v) => ({ ...v, bmiTenths: bmiTenths(v.weightG, v.heightMm), flags: vitalsFlags(v) })),
    consult,
    history,
    canWrite,
    canRecordVitals,
  }
}

/**
 * checked_in -> in_consultation through the SP3 state machine (which audits the change); already
 * in consultation is a no-op success; a closed visit is invalid_transition. The caller ran the
 * role gate and ownership check; actingProviderId re-checks ownership under the row lock.
 */
export async function startConsultation(encounterId: number, session: Session, actingProviderId: number | null):
  Promise<{ ok: true; status: 'in_consultation'; changed: boolean } | { ok: false; error: 'not_found' | 'not_owner' | 'invalid_transition' }> {
  const current = await getEncounterById(encounterId)
  if (!current) return { ok: false, error: 'not_found' }
  if (actingProviderId != null && current.providerId !== actingProviderId) return { ok: false, error: 'not_owner' }
  if (current.status === 'in_consultation') return { ok: true, status: 'in_consultation', changed: false }
  if (current.status !== 'checked_in') return { ok: false, error: 'invalid_transition' }

  const result = await transitionEncounter(encounterId, 'in_consultation', session, { actingProviderId })
  if (result.ok) return { ok: true, status: 'in_consultation', changed: true }
  if (result.error === 'invalid_transition') {
    // A double click raced us to it: the visit is in consultation now, which is what was asked.
    const after = await getEncounterById(encounterId)
    if (after?.status === 'in_consultation') return { ok: true, status: 'in_consultation', changed: false }
  }
  if (result.error === 'not_found' || result.error === 'not_owner') return { ok: false, error: result.error }
  return { ok: false, error: 'invalid_transition' }
}

/** The live (non-cancelled) visit created from each appointment, keyed by appointment id. */
export async function encountersForAppointments(appointmentIds: number[]): Promise<Map<number, { encounterId: number; status: EncounterStatus }>> {
  const out = new Map<number, { encounterId: number; status: EncounterStatus }>()
  if (appointmentIds.length === 0) return out
  const rows = await getDb().select({ appointmentId: encounters.appointmentId, id: encounters.id, status: encounters.status })
    .from(encounters).where(and(inArray(encounters.appointmentId, appointmentIds), ne(encounters.status, 'cancelled')))
  for (const r of rows) if (r.appointmentId !== null) out.set(r.appointmentId, { encounterId: r.id, status: r.status })
  return out
}

/** UHID per patient id (display only: the chart id is never shown). */
export async function uhidsForPatients(patientIds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(patientIds)]
  if (unique.length === 0) return new Map()
  const rows = await getDb().select({ id: patients.id, uhid: patients.uhid }).from(patients).where(inArray(patients.id, unique))
  return new Map(rows.map((r) => [r.id, r.uhid]))
}

/** The department of a provider profile, for the doctor home header. */
export async function providerDepartmentName(providerId: number): Promise<string | null> {
  const [row] = await getDb().select({ name: departments.name }).from(providers)
    .innerJoin(departments, eq(departments.id, providers.departmentId)).where(eq(providers.id, providerId))
  return row?.name ?? null
}

/** Coded diagnosis values on the patient's chart (drug suggestions in the Rx dialog). */
export async function patientDiagnosisCodes(patientId: string): Promise<string[]> {
  const rows = await getDb().select({ code: diagnoses.code }).from(diagnoses).where(and(eq(diagnoses.patientId, patientId), liveDiagnosis))
  return rows.map((r) => r.code).filter((c) => c !== '')
}

const RECENT_PATIENT_LIMIT = 200

/**
 * The doctor's own patients: anyone with a non-cancelled visit with this provider on or after
 * sinceIso (an IST date), or admitted under them since then or still admitted. Newest contact first,
 * in the PatientsTable hospital-view shape.
 */
export async function listMyRecentPatients(providerId: number, sinceIso: string): Promise<PatientRow[]> {
  const db = getDb()
  const since = new Date(`${sinceIso}T00:00:00+05:30`)
  const [visits, stays] = await Promise.all([
    db.select({ patientId: encounters.patientId, at: encounters.checkedInAt }).from(encounters)
      .where(and(eq(encounters.providerId, providerId), gte(encounters.encounterDate, sinceIso), ne(encounters.status, 'cancelled'))),
    db.select({ patientId: admissions.patientId, at: admissions.admittedAt }).from(admissions)
      .where(and(eq(admissions.attendingProviderId, providerId), or(gte(admissions.admittedAt, since), eq(admissions.status, 'admitted')))),
  ])
  const lastContact = new Map<string, Date>()
  for (const r of [...visits, ...stays]) {
    const prev = lastContact.get(r.patientId)
    if (!prev || r.at > prev) lastContact.set(r.patientId, r.at)
  }
  if (lastContact.size === 0) return []
  const ids = [...lastContact.entries()].sort((a, b) => b[1].getTime() - a[1].getTime()).slice(0, RECENT_PATIENT_LIMIT).map(([id]) => id)

  const [rows, payerRows] = await Promise.all([
    db.select({ id: patients.id, name: patients.name, dob: patients.dob, uhid: patients.uhid, phone: patients.phone, gender: patients.gender, currentProvider: patients.currentProvider, referralType: patients.referralType })
      .from(patients).where(inArray(patients.id, ids)),
    db.select({ patientId: patientPolicies.patientId, name: payers.name }).from(patientPolicies)
      .innerJoin(payers, eq(payers.id, patientPolicies.insurerPayerId))
      .where(and(inArray(patientPolicies.patientId, ids), eq(patientPolicies.priority, 'primary'), eq(patientPolicies.status, 'active')))
      .orderBy(asc(patientPolicies.id)),
  ])
  const payerByPatient = new Map<string, string>()
  for (const r of payerRows) payerByPatient.set(r.patientId, r.name) // later policy wins, as the directory
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id) => {
    const r = byId.get(id)
    if (!r) return []
    return [{
      id: r.id, name: r.name, dob: String(r.dob), uhid: r.uhid, phone: r.phone, gender: r.gender ?? null,
      currentProvider: r.currentProvider, referralType: r.referralType, lastCommunication: null,
      lastVisitAt: lastContact.get(id)!.toISOString(), primaryPayerName: payerByPatient.get(id) ?? null,
    }]
  })
}

// WS1 T5 (spec ruling 4): completing a visit. An OPD visit needs at least one live diagnosis, or a
// stated reason why there is none (stored on the consult record, audited without its text). IPD
// visits complete through discharge and lab visits are exempt, so neither is guarded here.
export const completeEncounterSchema = z.object({ noDiagnosisReason: z.string().trim().min(5).max(300).optional() }).strict()

export type CompleteEncounterWarning = 'no_vitals' | 'unsigned_notes'
export type CompleteEncounterResult =
  | { ok: true; encounter: EncounterRow; warnings: CompleteEncounterWarning[] }
  | { ok: false; error: 'not_found' | 'not_owner' | 'invalid_transition' | 'diagnosis_missing' }

/** Stores the no-diagnosis reason while the visit is still open; false when it has closed meanwhile. */
async function recordNoDiagnosisReason(encounter: EncounterRow, reason: string, session: Session): Promise<boolean> {
  const now = new Date()
  return getDb().transaction(async (tx) => {
    // Share-lock: a concurrent completion (FOR UPDATE) waits for this write, as in encounter-clinical.
    const [row] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, encounter.id)).for('share')
    if (!row || !isOpen(row.status)) return false
    await tx.insert(encounterConsults).values({
      encounterId: encounter.id, patientId: encounter.patientId, noDiagnosisReason: reason, updatedAt: now, updatedByName: session.name,
    }).onConflictDoUpdate({
      target: encounterConsults.encounterId,
      set: { noDiagnosisReason: reason, updatedAt: now, updatedByName: session.name },
    })
    // The reason is clinical free text: it stays on the consult row, never in the audit log.
    await logAudit(session, 'recorded no-diagnosis reason', encounter.patientId, `encounter=${encounter.id}`, tx)
    return true
  })
}

async function completionWarnings(encounterId: number): Promise<CompleteEncounterWarning[]> {
  const db = getDb()
  const [[vitals], [draft]] = await Promise.all([
    db.select({ id: encounterVitals.id }).from(encounterVitals).where(eq(encounterVitals.encounterId, encounterId)).limit(1),
    db.select({ id: encounterNotes.id }).from(encounterNotes).where(and(eq(encounterNotes.encounterId, encounterId), eq(encounterNotes.status, 'draft'))).limit(1),
  ])
  const warnings: CompleteEncounterWarning[] = []
  if (!vitals) warnings.push('no_vitals')
  if (draft) warnings.push('unsigned_notes')
  return warnings
}

/**
 * Completes a visit through the SP3 state machine (transitionEncounter, unchanged, which re-checks
 * ownership under the row lock and audits the change). The caller ran the role gate; a pi passes
 * their own provider id (a non-admin without one is refused as not_owner). The reason is written before the transition (harmless if it then fails).
 */
export async function completeEncounter(
  encounterId: number,
  session: Session,
  opts: { noDiagnosisReason?: string; actingProviderId: number | null },
): Promise<CompleteEncounterResult> {
  // Only an admin acts without a provider profile; a null id for anyone else is never trusted.
  if (session.role !== 'admin' && opts.actingProviderId == null) return { ok: false, error: 'not_owner' }
  const current = await getEncounterById(encounterId)
  if (!current) return { ok: false, error: 'not_found' }
  if (opts.actingProviderId != null && current.providerId !== opts.actingProviderId) return { ok: false, error: 'not_owner' }

  // A closed visit skips the guard: the transition below refuses it as invalid_transition.
  if (current.encounterType === 'opd' && isOpen(current.status)) {
    const [live] = await getDb().select({ id: diagnoses.id }).from(diagnoses)
      .where(and(eq(diagnoses.encounterId, encounterId), liveDiagnosis)).limit(1)
    if (!live) {
      if (opts.noDiagnosisReason === undefined) return { ok: false, error: 'diagnosis_missing' }
      if (!(await recordNoDiagnosisReason(current, opts.noDiagnosisReason, session))) return { ok: false, error: 'invalid_transition' }
    }
  }

  const result = await transitionEncounter(encounterId, 'completed', session, { actingProviderId: opts.actingProviderId })
  if (!result.ok) {
    // Any other refusal (admission_active today, more later) means this visit cannot complete now.
    return { ok: false, error: result.error === 'not_found' || result.error === 'not_owner' ? result.error : 'invalid_transition' }
  }
  return { ok: true, encounter: result.encounter, warnings: await completionWarnings(encounterId) }
}
