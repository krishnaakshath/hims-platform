import { getDb } from '@/db/client'
import { patients, patientContacts, diagnoses, medicationEpisodes, appointments, providers, formSubmissions, formTemplates, formSubmissionConsents } from '@/db/schema'
import { eq, desc, asc, gte, lt, and, sql } from 'drizzle-orm'
import { hashPassword, verifyPassword } from '@/lib/password'
import { getUnreadCountForPatient } from '@/lib/queries/messages'
import { isAadhaarOnFile } from '@/lib/queries/patient-profile'
import { stateName } from '@/lib/india/reference'

/**
 * The patient's own identity details for the portal's "Your details"
 * section. Aadhaar is a bare on-file flag -- the portal never sees last4,
 * the decline reason or anything else from the Aadhaar record (spec §3).
 * The ABHA number is masked to its last 4.
 */
export interface PortalProfile {
  uhid: string | null
  abhaAddress: string | null
  abhaNumberMasked: string | null
  addressSummary: string | null
  emergencyContactName: string | null
  aadhaarOnFile: boolean
}

type ProfileSource = Pick<typeof patients.$inferSelect, 'uhid' | 'abhaAddress' | 'abhaNumber' | 'city' | 'district' | 'stateCode' | 'pinCode'>

function addressSummary(p: ProfileSource): string | null {
  const state = p.stateCode ? stateName(p.stateCode) : null
  if (!p.city || !p.district || !state || !p.pinCode) return null
  return `${p.city}, ${p.district}, ${state} ${p.pinCode}`
}

async function getPortalProfile(patient: ProfileSource, patientId: string): Promise<PortalProfile> {
  const [emergency] = await getDb()
    .select({ name: patientContacts.name })
    .from(patientContacts)
    .where(and(eq(patientContacts.patientId, patientId), eq(patientContacts.kind, 'emergency')))
    .orderBy(desc(patientContacts.isPrimary), asc(patientContacts.id))
    .limit(1)
  return {
    uhid: patient.uhid,
    abhaAddress: patient.abhaAddress,
    abhaNumberMasked: patient.abhaNumber && /^\d{14}$/.test(patient.abhaNumber) ? `XX-XXXX-XXXX-${patient.abhaNumber.slice(-4)}` : null,
    addressSummary: addressSummary(patient),
    emergencyContactName: emergency?.name ?? null,
    aadhaarOnFile: await isAadhaarOnFile(patientId),
  }
}

/**
 * Everything a patient is allowed to see about themselves through the
 * portal -- deliberately excludes clinician notes (formNotes,
 * reviewerNotes, clinicianReviewerNotes, piRecommendation, oldNotes,
 * oldRecs), both encrypted-ID ref columns, and internal trial-eligibility
 * screening verdicts. This is patient-facing PHI display, not staff chart
 * review, and none of those fields are appropriate to show a patient about
 * their own record.
 */
export async function getPatientPortalData(patientId: string) {
  const [patient] = await getDb().select().from(patients).where(eq(patients.id, patientId))
  if (!patient) return null

  const dx = await getDb().select({ code: diagnoses.code, description: diagnoses.description, date: diagnoses.date }).from(diagnoses).where(eq(diagnoses.patientId, patientId))
  const meds = await getDb()
    .select({ id: medicationEpisodes.id, name: medicationEpisodes.name, medicationClass: medicationEpisodes.medicationClass, dose: medicationEpisodes.dose, startDate: medicationEpisodes.startDate, stopDate: medicationEpisodes.stopDate, status: medicationEpisodes.status })
    .from(medicationEpisodes)
    .where(eq(medicationEpisodes.patientId, patientId))

  const now = new Date()
  const upcoming = await getDb()
    .select({ id: appointments.id, startsAt: appointments.startsAt, visitReason: appointments.visitReason, status: appointments.status, providerName: providers.name })
    .from(appointments)
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(eq(appointments.patientId, patientId), gte(appointments.startsAt, now)))
    .orderBy(asc(appointments.startsAt))

  const past = await getDb()
    .select({ id: appointments.id, startsAt: appointments.startsAt, visitReason: appointments.visitReason, status: appointments.status, providerName: providers.name })
    .from(appointments)
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(eq(appointments.patientId, patientId), lt(appointments.startsAt, now)))
    .orderBy(desc(appointments.startsAt))
    .limit(10)

  // Forms sent to this patient were previously only reachable through a
  // separate, out-of-band token link (e.g. texted/emailed by staff) --
  // never surfaced anywhere inside the portal itself, so a patient who
  // lost or never received that link had no way to find or fill a form
  // they'd been sent. Surface every submission by access token instead.
  const forms = await getDb()
    .select({ id: formSubmissions.id, status: formSubmissions.status, sentDate: formSubmissions.sentDate, accessToken: formSubmissions.accessToken, templateName: formTemplates.name, category: formTemplates.category, hasAttachedConsents: sql<boolean>`count(${formSubmissionConsents.id}) > 0` })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .leftJoin(formSubmissionConsents, eq(formSubmissionConsents.formSubmissionId, formSubmissions.id))
    .where(eq(formSubmissions.patientId, patientId))
    .groupBy(formSubmissions.id, formTemplates.name, formTemplates.category)
    .orderBy(desc(formSubmissions.sentDate))

  const unreadMessageCount = await getUnreadCountForPatient(patientId)
  const profile = await getPortalProfile(patient, patientId)

  return {
    id: patient.id,
    name: patient.name,
    dob: patient.dob,
    currentProvider: patient.currentProvider,
    portalConfigured: !!patient.portalPasswordHash,
    diagnoses: dx,
    activeMedications: meds.filter((m) => m.status === 'active'),
    pastMedications: meds.filter((m) => m.status === 'inactive'),
    upcomingAppointments: upcoming,
    pastAppointments: past,
    forms,
    unreadMessageCount,
    profile,
  }
}

/**
 * Just enough to render the persistent portal shell's identity bar (name,
 * DOB, ID) -- used by the (authenticated) layout, which needs this on
 * every page but not the full diagnoses/meds/appointments/forms payload
 * getPatientPortalData() fetches for whichever single page is active.
 */
export async function getPatientPortalIdentity(patientId: string) {
  const [patient] = await getDb().select({ id: patients.id, name: patients.name, dob: patients.dob }).from(patients).where(eq(patients.id, patientId))
  if (!patient) return null
  return {
    id: patient.id,
    name: patient.name,
    dob: patient.dob,
  }
}

export async function verifyPatientPortalCredentials(patientId: string, password: string): Promise<boolean> {
  const [patient] = await getDb().select({ portalPasswordHash: patients.portalPasswordHash }).from(patients).where(eq(patients.id, patientId))
  if (!patient?.portalPasswordHash) return false
  return verifyPassword(password, patient.portalPasswordHash)
}

// A well-formed stored hash (16-byte salt : 64-byte key, hex) that no
// password can match. Verifying against it costs one full scrypt, so a login
// whose identifier resolves to no usable patient takes about as long as a
// wrong password for a real one -- response time never reveals whether an
// email or patient ID exists.
const DUMMY_PORTAL_PASSWORD_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`

export type PortalLoginCandidate = { id: string; portalPasswordHash: string | null }

/**
 * The portal login field accepts either the patient's email or their patient
 * ID. An identifier containing '@' is an email: it resolves to a patient only
 * when exactly one patient has that email (trimmed, case-insensitive) -- zero
 * or several matches resolve to nothing, never to an arbitrary pick. Anything
 * else is a patient ID, matched exactly. One query either way: the patient id
 * and its portal password hash come back together.
 */
export async function findPortalLoginCandidate(identifier: string): Promise<PortalLoginCandidate | null> {
  const trimmed = identifier.trim()
  if (!trimmed) return null
  const where = trimmed.includes('@')
    ? sql`lower(trim(${patients.email})) = ${trimmed.toLowerCase()}`
    : eq(patients.id, trimmed)
  const matches = await getDb()
    .select({ id: patients.id, portalPasswordHash: patients.portalPasswordHash })
    .from(patients)
    .where(where)
    .limit(2)
  return matches.length === 1 ? matches[0] : null
}

/**
 * Checks the password against a candidate from findPortalLoginCandidate.
 * Returns the patient id on success and null on ANY failure (no candidate,
 * no portal access provisioned, wrong password), always after exactly one
 * password verification -- a missing candidate verifies against a dummy hash
 * so response time never reveals whether an email or patient ID exists.
 */
export function checkPortalLoginPassword(candidate: PortalLoginCandidate | null, password: string): string | null {
  if (!candidate?.portalPasswordHash) {
    verifyPassword(password, DUMMY_PORTAL_PASSWORD_HASH)
    return null
  }
  return verifyPassword(password, candidate.portalPasswordHash) ? candidate.id : null
}

/**
 * Portal login credential check by email or patient ID: one query, one
 * password verification. Callers must use the returned id -- never the
 * identifier the user typed -- for sessions, MFA and audit rows.
 */
export async function verifyPatientPortalLogin(identifier: string, password: string): Promise<string | null> {
  return checkPortalLoginPassword(await findPortalLoginCandidate(identifier), password)
}

export async function setPatientPortalPassword(patientId: string, plaintextPassword: string): Promise<void> {
  await getDb().update(patients).set({ portalPasswordHash: hashPassword(plaintextPassword) }).where(eq(patients.id, patientId))
}

export async function revokePatientPortalAccess(patientId: string): Promise<void> {
  await getDb().update(patients).set({ portalPasswordHash: null }).where(eq(patients.id, patientId))
}

export async function getPatientMfaState(patientId: string): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean } | null> {
  const [row] = await getDb().select({ mfaSecretEncrypted: patients.mfaSecretEncrypted, mfaEnabled: patients.mfaEnabled }).from(patients).where(eq(patients.id, patientId))
  return row ?? null
}

export async function setPatientMfaSecret(patientId: string, secretEncrypted: string): Promise<void> {
  await getDb().update(patients).set({ mfaSecretEncrypted: secretEncrypted }).where(eq(patients.id, patientId))
}

export async function enablePatientMfa(patientId: string): Promise<void> {
  await getDb().update(patients).set({ mfaEnabled: true }).where(eq(patients.id, patientId))
}

export async function resetPatientMfa(patientId: string): Promise<void> {
  await getDb().update(patients).set({ mfaSecretEncrypted: null, mfaEnabled: false }).where(eq(patients.id, patientId))
}
