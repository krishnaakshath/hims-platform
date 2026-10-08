import { sql, eq, and } from 'drizzle-orm'
import { getDb } from './client'
import { encryptSensitive } from '../lib/crypto'
import { hashPassword } from '../lib/password'
import type { Session } from '../lib/auth'
import { nextUhid } from '../lib/queries/uhid'
import { setPatientPortalPassword } from '../lib/queries/patient-portal'
import { addDaysIso } from '../lib/follow-ups/rules'
import { todayIsoIn } from '../lib/india-time'
import {
  // SP6
  codingQueryResponses, codingQueries, encounterCodingEvents, encounterCoding, encounterProcedures, serviceProcedureCodes,
  trials,
  patients,
  diagnoses,
  medicationEpisodes,
  patientTrialScreenings,
  screeningCriteriaResults,
  users,
  payers,
  charges,
  insuranceClaims,
  patientStatements,
  mockPayments,
  formTemplates,
  formSubmissions,
  formTemplateFolders,
  consentDocuments,
  formTemplateConsents,
  formSubmissionConsents,
  formSubmissionScores,
  formChartDiscrepancies,
  allergies,
  identityVerifications,
  patientContacts,
  patientAadhaar,
  appSettings,
  providers,
  departments,
  serviceCatalog,
  roomCategories,
  tariffRates,
  servicePackageItems,
  // SP4
  chargeLines,
  chargeRuleConfigs,
  billingSettings,
  refunds,
  patientPayments,
  creditNotes,
  invoiceLines,
  invoices,
  documentCounters,
  // end SP4
  // SP7
  patientPolicies, preauths, preauthEvents, preauthDocuments, rcmQueries, rcmQueryResponses, claims, claimInvoices,
  claimSubmissions, claimDispatches, claimEvents, claimDocuments, claimDisallowances, claimSettlements, claimWriteOffs,
  // SP8
  nhcxInboundCalls, nhcxExchanges, nhcxEligibilityChecks, abdmProfileShares, abdmConsents,
  // SP3
  encounters,
  followUpOrders,
  followUpContactAttempts,
  // SP5
  labOrders,
  labResults,
  labRequisitions,
  homeCollectionVisits,
  homeCollectionWindows,
  labServiceAreaPins,
  labReports,
  notificationDeliveries,
  // Wave D: every remaining child of patients/appointments/rooms/providers, so a reset can clear
  appointments,
  admissions,
  admissionTransfers,
  doctorAssignments,
  bookingRequests,
  telemedicineSessions,
  telemedicineSignals,
  encounterNotes,
  signatures,
  messages,
  medicationAdministrations,
  medicationDispenses,
  insuranceEligibilityChecks,
  carePlans,
  carePlanGoals,
  // end Wave D
  rooms,
  documents,
  faxes,
  broadcasts,
  reviews,
  medications,
  medicationInventory,
  labTests,
  staffMembers,
  staffCredentials,
  policyDocuments,
  adverseEvents,
  drugAccountabilityEntries,
  regulatoryDocuments,
} from './schema'
// Wave D: India demo data
import {
  DEMO_HOSPITAL, DEMO_USERS, FILLER_PROFILES, HERO_IDENTITIES, LEGACY_US_PAYER_NAMES, addressFor, demoEmail,
  syntheticAbhaNumber, syntheticMobile, type HeroIdentity, type PatientProfileSeed,
} from './seed-india-data'
import { seedAadhaar, seedContacts, seedIndiaOperations, seedIndiaReference, type IndiaRefs } from './seed-india'
// end Wave D

const MDD_TRIAL = {
  id: 'nct06911112',
  name: 'Adjunctive Treatment in Major Depressive Disorder',
  nctNumber: 'NCT06911112',
  condition: 'Major Depressive Disorder',
  site: 'Bengaluru',
  studyDrug: 'NBI-1065845',
  ageMin: 18,
  ageMax: 65,
  diagnosisCodes: [
    { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
  ],
  ratingScales: [{ name: 'PHQ-9', description: 'Patient Health Questionnaire-9' }],
  medicationClasses: [
    { className: 'SSRI/SNRI antidepressant', washoutDays: 56, rule: 'On current antidepressant dose for at least 8 weeks', ruleType: 'required_stable' as const },
    { className: 'NDRI (excluded class)', washoutDays: 0, rule: 'Not currently on an excluded medication class', ruleType: 'washout_exclusion' as const },
  ],
  exclusionDiagnoses: [
    { code: 'F20.9', description: 'Schizophrenia, unspecified' },
    { code: 'F31.9', description: 'Bipolar disorder, unspecified (manic features exclude MDD-only protocol)' },
    { code: 'F10.20', description: 'Alcohol use disorder, moderate' },
  ],
  minRatingScaleScore: 10,
}

const ADHD_TRIAL = {
  id: 'nct-adhd-demo-01',
  name: 'Extended-Release Stimulant Response Study',
  nctNumber: 'NCT-ADHD-0001',
  condition: 'ADHD',
  site: 'Bengaluru',
  studyDrug: 'XR-STIM-01',
  ageMin: 18,
  ageMax: 55,
  diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
  ratingScales: [{ name: 'ASRS-v1.1', description: 'Adult ADHD Self-Report Scale' }],
  medicationClasses: [{ className: 'Stimulant', washoutDays: 14, rule: 'No stimulant medication within the last 14 days', ruleType: 'washout_exclusion' as const }],
  exclusionDiagnoses: [
    { code: 'F20.9', description: 'Schizophrenia, unspecified' },
    { code: 'F10.20', description: 'Alcohol use disorder, moderate' },
  ],
  minRatingScaleScore: 14,
}

// ---------------------------------------------------------------------------
// Demo-account configuration (never hardcoded; see .env.example)
// ---------------------------------------------------------------------------

/** Throws when the seed must not run: production without explicit opt-in. */
export function assertSeedAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const isProd = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production'
  if (isProd && env.ALLOW_PRODUCTION_SEED !== '1') {
    throw new Error(
      'Refusing to seed: this looks like a production environment (NODE_ENV or VERCEL_ENV is "production"). ' +
        'The seed writes demo data and accounts. Set ALLOW_PRODUCTION_SEED=1 only if you really intend this.',
    )
  }
}

/** Domain for the demo staff accounts (SEED_EMAIL_DOMAIN, default example.test). */
export function seedEmailDomain(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SEED_EMAIL_DOMAIN ?? '').trim().toLowerCase()
  if (!raw) return 'example.test'
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) {
    throw new Error('SEED_EMAIL_DOMAIN must be a plain domain name such as example.test')
  }
  return raw
}

export function seedEmail(localPart: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${localPart}@${seedEmailDomain(env)}`
}

/** Shared demo password from SEED_DEMO_PASSWORD. Required; there is no default. */
export function seedDemoPassword(env: NodeJS.ProcessEnv = process.env): string {
  const pw = env.SEED_DEMO_PASSWORD
  if (!pw || pw.length < 12) {
    throw new Error('SEED_DEMO_PASSWORD is required (at least 12 characters). Set it in your environment; there is no default.')
  }
  return pw
}

/** Wave D: SEED_RESET=1 clears and rebuilds the demo even when patients already exist. */
export function seedResetRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEED_RESET === '1'
}

/** The actor recorded on audit rows the seed writes through app functions with no staff user. */
const SEED_ACTOR: Session = { role: 'admin', name: 'Demo seed', userId: null }

type HeroPatient = HeroIdentity & {
  trialId: string; overallStatus: 'green' | 'yellow' | 'red'
  provider: string; ratingScale: { name: string; score: number; date: string }
  diagnosisCode: { code: string; description: string }
  activeMed: { name: string; medicationClass: string; dose: string; startDate: string }
  criteria: { key: string; text: string; verdict: 'green' | 'yellow' | 'red'; quote: string; sourceDoc: string; sourceDate: string }[]
}

const hero = (id: string) => HERO_IDENTITIES.find((h) => h.id === id)!

// The six hand-authored clinical-research patients. Identities are Indian (seed-india-data.ts);
// ids, DOBs, trials, verdicts and evidence are unchanged.
const HERO_PATIENTS: HeroPatient[] = [
  {
    ...hero('RD-0001'), trialId: 'nct06911112', overallStatus: 'green',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 18, date: '2026-09-01' },
    diagnosisCode: { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
    activeMed: { name: 'Sertraline', medicationClass: 'SSRI/SNRI antidepressant', dose: '100mg daily', startDate: '2026-06-01' },
    criteria: [
      { key: 'age-range', text: 'Age 18-65', verdict: 'green', quote: 'DOB 1985-03-12 (age 41)', sourceDoc: 'Tebra Patient record', sourceDate: '2026-09-01' },
      { key: 'diagnosis', text: 'Confirmed MDD diagnosis (F32.x/F33.x)', verdict: 'green', quote: 'Dx: F33.1 Major depressive disorder, recurrent, moderate', sourceDoc: 'Tebra Condition list', sourceDate: '2025-01-15' },
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'green', quote: 'Sertraline 100mg daily, start 2026-06-01', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-06-01' },
    ],
  },
  {
    ...hero('RD-0002'), trialId: 'nct06911112', overallStatus: 'red',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 9, date: '2026-08-20' },
    diagnosisCode: { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    activeMed: { name: 'Bupropion', medicationClass: 'NDRI (excluded class)', dose: '150mg daily', startDate: '2026-08-01' },
    criteria: [
      { key: 'diagnosis', text: 'Confirmed MDD diagnosis (F32.x/F33.x)', verdict: 'green', quote: 'Dx: F32.1 Major depressive disorder, single episode, moderate', sourceDoc: 'Tebra Condition list', sourceDate: '2026-08-01' },
      { key: 'excluded-medication', text: 'Not currently on an excluded medication class', verdict: 'red', quote: 'Bupropion 150mg daily, start 2026-08-01 — protocol excludes NDRI class', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-08-01' },
    ],
  },
  {
    ...hero('RD-0003'), trialId: 'nct06911112', overallStatus: 'yellow',
    provider: 'Unmatched', ratingScale: { name: 'PHQ-9', score: 15, date: '2026-09-05' },
    diagnosisCode: { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    activeMed: { name: 'Unknown', medicationClass: 'Unknown', dose: 'Unknown', startDate: '2026-01-01' },
    criteria: [
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'yellow', quote: 'No matching Tebra chart yet — identity match pending', sourceDoc: 'N/A', sourceDate: '2026-09-05' },
    ],
  },
  {
    ...hero('RD-0004'), trialId: 'nct-adhd-demo-01', overallStatus: 'green',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'ASRS-v1.1', score: 21, date: '2026-09-02' },
    diagnosisCode: { code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' },
    activeMed: { name: 'None', medicationClass: 'None', dose: 'N/A', startDate: '2026-01-01' },
    criteria: [
      { key: 'diagnosis', text: 'Confirmed ADHD diagnosis (F90.x)', verdict: 'green', quote: 'Dx: F90.2 Attention-deficit hyperactivity disorder, combined type', sourceDoc: 'Tebra Condition list', sourceDate: '2025-11-01' },
      { key: 'stimulant-washout', text: 'No stimulant medication within the last 14 days', verdict: 'green', quote: 'No active or recent stimulant prescriptions on file', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-09-02' },
    ],
  },
  {
    ...hero('RD-0005'), trialId: 'nct-adhd-demo-01', overallStatus: 'red',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'ASRS-v1.1', score: 19, date: '2026-08-28' },
    diagnosisCode: { code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' },
    activeMed: { name: 'Lisdexamfetamine', medicationClass: 'Stimulant', dose: '30mg daily', startDate: '2026-09-01' },
    criteria: [
      { key: 'stimulant-washout', text: 'No stimulant medication within the last 14 days', verdict: 'red', quote: 'Lisdexamfetamine 30mg daily, active as of 2026-09-01', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-09-01' },
    ],
  },
  {
    ...hero('RD-0006'), trialId: 'nct06911112', overallStatus: 'yellow',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 16, date: '2026-08-15' },
    diagnosisCode: { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
    activeMed: { name: 'Venlafaxine', medicationClass: 'SSRI/SNRI antidepressant', dose: '75mg daily', startDate: '2026-08-10' },
    criteria: [
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'yellow', quote: 'Venlafaxine start date 2026-08-10 is only 5 weeks before referral — needs verification against the 8-week rule', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-08-10' },
    ],
  },
]

// Criterion keys among HERO_PATIENTS' hand-authored demo criteria that are
// actually exclusion rules -- everything else defaults to inclusion. Only
// matters for the initial seed's display; the real evaluator (lib/eligibility.ts)
// tags every criterion it generates directly and supersedes these on the
// first Refresh/Run Classification.
const EXCLUSION_CRITERION_KEYS = new Set(['excluded-medication', 'stimulant-washout'])

const REFERRAL_TYPES = ['Self-referral', 'Doctor referral', 'Health camp', 'Insurance network referral']
const AVAILABILITY_OPTIONS = ['Weekday mornings', 'Weekday afternoons', 'Evenings only', 'Flexible', 'Weekends only']

// A general-hospital panel: most patients are not in either study, which is
// exactly why most of them get no trial screening row (see seedFillerPatients).
const GENERAL_DIAGNOSES = [
  { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications' },
  { code: 'I10', description: 'Essential (primary) hypertension' },
  { code: 'E03.9', description: 'Hypothyroidism, unspecified' },
  { code: 'J45.9', description: 'Asthma, unspecified' },
  { code: 'K21.9', description: 'Gastro-oesophageal reflux disease without oesophagitis' },
  { code: 'M17.9', description: 'Gonarthrosis, unspecified' },
  { code: 'F41.1', description: 'Generalized anxiety disorder' },
  { code: 'D50.9', description: 'Iron deficiency anaemia, unspecified' },
]

const GENERAL_MEDICATIONS = [
  { name: 'Metformin 500 mg', medicationClass: 'Biguanide', dose: '500 mg twice daily' },
  { name: 'Amlodipine 5 mg', medicationClass: 'Calcium channel blocker', dose: '5 mg once daily' },
  { name: 'Levothyroxine 50 mcg', medicationClass: 'Thyroid hormone', dose: '50 mcg before breakfast' },
  { name: 'Escitalopram', medicationClass: 'SSRI/SNRI antidepressant', dose: '10mg daily' },
  { name: 'Atorvastatin 10 mg', medicationClass: 'Statin', dose: '10 mg at night' },
  { name: 'Pantoprazole 40 mg', medicationClass: 'Proton pump inhibitor', dose: '40 mg before breakfast' },
  { name: 'Ferrous ascorbate', medicationClass: 'Iron supplement', dose: '1 tablet daily' },
  { name: 'Methylphenidate ER', medicationClass: 'Stimulant', dose: '36mg daily' },
]

/** Indian demographic columns for a new patient row, with a freshly issued UHID. */
async function indianPatientColumns(p: PatientProfileSeed, placeIndex: number, streetIndex: number, serial: number) {
  const address = addressFor(placeIndex, streetIndex)
  const first = p.name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')
  const last = (p.name.split(' ')[1] ?? 'demo').toLowerCase().replace(/[^a-z]/g, '')
  // Most patients have an ABHA (number and @sbx sandbox address); some have not created one yet.
  const hasAbha = serial % 3 !== 2
  return {
    uhid: await nextUhid(getDb()),
    gender: p.gender, maritalStatus: p.maritalStatus, bloodGroup: p.bloodGroup, occupation: p.occupation,
    preferredLanguage: p.preferredLanguage, nationality: 'IN',
    addressLine1: address.addressLine1, city: address.city, district: address.district, stateCode: address.stateCode, pinCode: address.pinCode,
    abhaNumber: hasAbha ? syntheticAbhaNumber(serial) : null,
    abhaAddress: hasAbha ? `${`${first}.${last}`.slice(0, 16).replace(/[._]+$/, '')}${String(serial).padStart(2, '0')}@sbx` : null,
    abhaUnavailableReason: hasAbha ? null : ('not_created' as const),
  }
}

async function seedFillerPatients() {
  const db = getDb()
  for (let i = 0; i < FILLER_PROFILES.length; i++) {
    const id = `RD-${String(7 + i).padStart(4, '0')}`

    // Safe to re-run against an already-populated shared dev DB: skip any id
    // that already exists (e.g. a real patient a user created by hand
    // through the app that happens to land on the same anon-id slot) rather
    // than failing or duplicating.
    const [existing] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))
    if (existing) continue

    const profile = FILLER_PROFILES[i]
    const birthYear = 1955 + (i * 7) % 50 // spreads ages roughly 21-71
    const birthMonth = String((i % 12) + 1).padStart(2, '0')
    const birthDay = String(((i * 3) % 27) + 1).padStart(2, '0')
    const inTrial = i % 3 === 0 // a third of the panel is in one of the two psychiatry studies
    const trial = i % 2 === 0 ? MDD_TRIAL : ADHD_TRIAL
    const status: 'green' | 'yellow' | 'red' = ['green', 'green', 'yellow', 'red'][i % 4] as 'green' | 'yellow' | 'red'

    await db.insert(patients).values({
      id,
      name: profile.name,
      dob: `${birthYear}-${birthMonth}-${birthDay}`,
      // RD-0007 (i === 0) is deliberately left with no phone number at all --
      // it's the one seeded broadcast recipient (Phase 5) whose SMS delivery
      // is meant to genuinely fail per simulateBroadcastDelivery's own logic,
      // rather than a hand-authored 'failed' status the simulator could
      // never actually produce for a patient with real contact info.
      phone: i === 0 ? null : syntheticMobile(300 + i),
      email: demoEmail(profile.name),
      currentProvider: inTrial ? 'Dr. R. Kunam' : null,
      ratingScales: inTrial ? [{ name: trial.ratingScales[0].name, score: 8 + (i % 16), date: '2026-09-01' }] : [],
      referralType: REFERRAL_TYPES[i % REFERRAL_TYPES.length],
      availability: AVAILABILITY_OPTIONS[i % AVAILABILITY_OPTIONS.length],
      commConsentSigned: i % 4 !== 3,
      commConsentPref: ['Phone', 'Email', 'Text'][i % 3],
      ...(await indianPatientColumns(profile, i, i, 7 + i)),
    })

    if (inTrial) {
      await db.insert(diagnoses).values({ patientId: id, code: trial.diagnosisCodes[0].code, description: trial.diagnosisCodes[0].description, date: '2026-08-01' })
      const screening = await db.insert(patientTrialScreenings).values({ patientId: id, trialId: trial.id, overallStatus: status }).returning()
      await db.insert(screeningCriteriaResults).values({
        screeningId: screening[0].id,
        criterionKey: 'diagnosis',
        criterionText: `Confirmed ${trial.condition} diagnosis`,
        criterionType: 'inclusion',
        verdict: status,
        evidenceQuote: `Dx: ${trial.diagnosisCodes[0].code} ${trial.diagnosisCodes[0].description}`,
        evidenceSourceDoc: 'Tebra Condition list',
        evidenceSourceDate: '2026-08-01',
      })
    } else {
      // General-hospital patient, not part of either study -- still a real
      // chart with its own diagnosis.
      const dx = GENERAL_DIAGNOSES[i % GENERAL_DIAGNOSES.length]
      await db.insert(diagnoses).values({ patientId: id, code: dx.code, description: dx.description, date: '2026-07-15' })
    }

    // Roughly half the panel has an active long-term medication on file.
    if (i % 2 === 0) {
      const med = GENERAL_MEDICATIONS[i % GENERAL_MEDICATIONS.length]
      await db.insert(medicationEpisodes).values({ patientId: id, name: med.name, medicationClass: med.medicationClass, dose: med.dose, startDate: '2026-06-01', status: 'active' })
    }

    // A handful of allergies, since real charts aren't uniformly blank here.
    if (i % 6 === 0) {
      const allergy = [{ allergen: 'Penicillin', reaction: 'Rash' }, { allergen: 'Sulfa drugs', reaction: 'Hives' }, { allergen: 'Diclofenac', reaction: 'Facial swelling' }, { allergen: 'Prawns', reaction: 'Anaphylaxis' }][i % 4]
      await db.insert(allergies).values({ patientId: id, allergen: allergy.allergen, reaction: allergy.reaction, severity: (['mild', 'moderate', 'severe'] as const)[i % 3] })
    }
  }
}

async function seedDocumentsAndFaxes() {
  const db = getDb()

  // Documents: metadata-only rows demonstrating the New/Processed status split,
  // a mix of labels, and both patient-linked and unlinked documents. Aadhaar
  // card images are deliberately never seeded (Aadhaar enters only through its
  // own consented, encrypted flow).
  await db.insert(documents).values([
    { name: 'Driving licence - front.jpg', documentDate: '2026-08-10', status: 'processed', receivedFrom: 'Patient portal upload', documentType: 'drivers_license', patientId: 'RD-0001', fileType: 'JPG' },
    { name: 'Signed consent form.pdf', documentDate: '2026-08-12', status: 'processed', receivedFrom: 'Jaya Raman (CRC)', documentType: 'legal_document', patientId: 'RD-0001', fileType: 'PDF' },
    { name: 'Outside lab report - Bengaluru diagnostics.pdf', documentDate: '2026-08-14', status: 'new', receivedFrom: 'Email', documentType: 'other', patientId: 'RD-0002', fileType: 'PDF' },
    { name: 'Referral letter from family physician.pdf', documentDate: '2026-08-15', status: 'new', receivedFrom: 'Referring doctor', documentType: 'other', patientId: 'RD-0003', fileType: 'PDF' },
    { name: 'Voter ID (EPIC) card.png', documentDate: '2026-08-16', status: 'processed', receivedFrom: 'Patient portal upload', documentType: 'other', patientId: 'RD-0002', fileType: 'PNG' },
    { name: 'Power of attorney.pdf', documentDate: '2026-08-18', status: 'new', receivedFrom: 'Courier', documentType: 'legal_document', patientId: 'RD-0004', fileType: 'PDF' },
    { name: 'Previous prescriptions.pdf', documentDate: '2026-08-19', status: 'processed', receivedFrom: 'Jaya Raman (CRC)', documentType: 'other', patientId: 'RD-0004', fileType: 'PDF' },
    { name: 'Health insurance e-card.jpg', documentDate: '2026-08-20', status: 'new', receivedFrom: 'Patient portal upload', documentType: 'insurance_card_primary_front', patientId: 'RD-0005', fileType: 'JPG' },
    { name: 'Teleconsultation consent.pdf', documentDate: '2026-08-21', status: 'processed', receivedFrom: 'Jaya Raman (CRC)', documentType: 'legal_document', patientId: 'RD-0006', fileType: 'PDF' },
    { name: 'Passport copy.pdf', documentDate: '2026-08-22', status: 'new', receivedFrom: 'Email', documentType: 'drivers_license', patientId: 'RD-0003', fileType: 'PDF' },
  ])

  // Faxes: a mix of delivered/failed SIMULATED statuses across several patients
  // and senders, so Fax History is demonstrable without ever implying a real
  // fax was sent (see the disclaimer requirement on the Fax History tab).
  await db.insert(faxes).values([
    { faxDate: new Date('2026-08-10T09:15:00+05:30'), subject: 'Lab results - CBC', documentsIncluded: 'CBC report.pdf', deliveryStatus: 'delivered', sender: 'Jaya Raman (CRC)', sentToFaxNumber: '+91 80 4000 2201', patientId: 'RD-0001' },
    { faxDate: new Date('2026-08-11T14:32:00+05:30'), subject: 'Signed consent form', documentsIncluded: 'General research consent.pdf', deliveryStatus: 'delivered', sender: 'Jaya Raman (CRC)', sentToFaxNumber: '+91 80 4000 2202', patientId: 'RD-0002' },
    { faxDate: new Date('2026-08-12T11:05:00+05:30'), subject: 'Records request', documentsIncluded: 'Records request form.pdf', deliveryStatus: 'failed', sender: 'Jaya Raman (CRC)', sentToFaxNumber: '+91 80 4000 2203', patientId: 'RD-0003' },
    { faxDate: new Date('2026-08-13T08:47:00+05:30'), subject: 'Pre-authorisation request', documentsIncluded: 'Pre-auth request.pdf', deliveryStatus: 'delivered', sender: 'Sanjay Patil (Admin)', sentToFaxNumber: '+91 80 4000 2204', patientId: 'RD-0004' },
    { faxDate: new Date('2026-08-14T16:20:00+05:30'), subject: 'Medication history', documentsIncluded: 'Medication history.pdf', deliveryStatus: 'delivered', sender: 'Jaya Raman (CRC)', sentToFaxNumber: '+91 80 4000 2205', patientId: 'RD-0005' },
    { faxDate: new Date('2026-08-15T10:00:00+05:30'), subject: 'Screening questionnaire results', documentsIncluded: 'PHQ-9 results.pdf, ASRS results.pdf', deliveryStatus: 'failed', sender: 'Jaya Raman (CRC)', sentToFaxNumber: '+91 80 4000 2206', patientId: 'RD-0006' },
    { faxDate: new Date('2026-08-16T13:40:00+05:30'), subject: 'Teleconsultation consent confirmation', documentsIncluded: 'Teleconsultation consent.pdf', deliveryStatus: 'delivered', sender: 'Jaya Raman (CRC)', sentToFaxNumber: '+91 80 4000 2207', patientId: 'RD-0006' },
    { faxDate: new Date('2026-08-17T09:55:00+05:30'), subject: 'Insurance verification', documentsIncluded: 'Insurance e-card copy.pdf', deliveryStatus: 'delivered', sender: 'Sanjay Patil (Admin)', sentToFaxNumber: '+91 80 4000 2208', patientId: 'RD-0002' },
  ])
}

// Demo data for the CRC's regulatory-compliance tabs on the trial detail
// page (adverse events, drug accountability, regulatory binder) -- a real
// CRC's job, not just pre-screening (see the schema comment on these three
// tables). Guarded per-table, same convention as seedMedications, so this
// is safe to call on a re-run against an already-seeded DB.
async function seedTrialCompliance() {
  const db = getDb()

  const [{ count: aeCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(adverseEvents)
  if (aeCount === 0) {
    await db.insert(adverseEvents).values([
      {
        trialId: 'nct06911112', patientId: 'RD-0001',
        description: 'Mild nausea for two days after dose increase.',
        severity: 'mild', serious: false, causality: 'possibly', outcome: 'resolved',
        onsetDate: '2026-08-15', reportedDate: '2026-08-16', reportedByName: 'Jaya Raman',
      },
      {
        trialId: 'nct06911112', patientId: 'RD-0002',
        description: 'Emergency visit for chest pain, ruled cardiac-unrelated; admitted overnight for observation.',
        severity: 'severe', serious: true, causality: 'unlikely', outcome: 'resolved',
        onsetDate: '2026-09-20', reportedDate: '2026-09-20', reportedByName: 'Jaya Raman',
        sponsorNotifiedAt: new Date('2026-09-20T18:00:00+05:30'), irbNotifiedAt: new Date('2026-09-22T09:00:00+05:30'),
      },
    ])
  }

  const [{ count: daCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(drugAccountabilityEntries)
  if (daCount === 0) {
    await db.insert(drugAccountabilityEntries).values([
      { trialId: 'nct06911112', patientId: null, lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'received', quantity: 500, performedByName: 'Jaya Raman', date: '2026-07-01', notes: 'Initial shipment from sponsor' },
      { trialId: 'nct06911112', patientId: 'RD-0001', lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'dispensed', quantity: 30, performedByName: 'Jaya Raman', date: '2026-08-01' },
      { trialId: 'nct06911112', patientId: 'RD-0002', lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'dispensed', quantity: 30, performedByName: 'Jaya Raman', date: '2026-08-03' },
      { trialId: 'nct06911112', patientId: 'RD-0001', lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'returned', quantity: 6, performedByName: 'Jaya Raman', date: '2026-08-29', notes: 'Participant missed 2 doses' },
    ])
  }

  const [{ count: regCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(regulatoryDocuments)
  if (regCount === 0) {
    await db.insert(regulatoryDocuments).values([
      { trialId: 'nct06911112', documentType: 'form_1572', title: 'Statement of Investigator', effectiveDate: '2026-06-01', uploadedByName: 'Jaya Raman' },
      { trialId: 'nct06911112', documentType: 'delegation_log', title: 'Site Delegation of Authority Log', version: 'v3', effectiveDate: '2026-07-15', uploadedByName: 'Jaya Raman' },
      { trialId: 'nct06911112', documentType: 'irb_approval', title: 'Institutional Ethics Committee continuing review approval', effectiveDate: '2025-10-01', expirationDate: '2026-10-01', uploadedByName: 'Jaya Raman' },
      { trialId: 'nct06911112', documentType: 'protocol', title: 'Study Protocol', version: 'Amendment 2', effectiveDate: '2026-03-01', uploadedByName: 'Jaya Raman' },
    ])
  }
}

// Lab test catalog -- standalone reference data (like the payer directory),
// independent of whether the rest of the DB has been seeded. Wave D adds the
// common Indian OPD panels (seed-india-data.ts INDIA_LAB_TESTS) on top.
const LAB_TESTS_SEED: { name: string; code: string; category: 'lab' | 'imaging'; defaultUnit: string | null; referenceRange: string | null }[] = [
  { name: 'CBC with differential', code: 'CBC-DIFF', category: 'lab', defaultUnit: 'cells/mcL', referenceRange: '4.5-11.0 x10^3/mcL' },
  { name: 'Comprehensive Metabolic Panel', code: 'CMP', category: 'lab', defaultUnit: null, referenceRange: 'See individual analytes' },
  { name: 'TSH', code: 'TSH', category: 'lab', defaultUnit: 'mIU/L', referenceRange: '0.4-4.0' },
  { name: 'Lipid Panel', code: 'LIPID', category: 'lab', defaultUnit: 'mg/dL', referenceRange: 'Total chol <200' },
  { name: 'HbA1c', code: 'HBA1C', category: 'lab', defaultUnit: '%', referenceRange: '4.0-5.6' },
  { name: 'Lithium level', code: 'LITH', category: 'lab', defaultUnit: 'mEq/L', referenceRange: '0.6-1.2' },
  { name: 'Valproic acid level', code: 'VPA', category: 'lab', defaultUnit: 'mcg/mL', referenceRange: '50-100' },
  { name: 'Urine drug screen', code: 'UDS', category: 'lab', defaultUnit: null, referenceRange: 'Negative' },
  { name: 'Prolactin', code: 'PRL', category: 'lab', defaultUnit: 'ng/mL', referenceRange: '4-15.2' },
  { name: 'Vitamin D, 25-OH', code: 'VITD', category: 'lab', defaultUnit: 'ng/mL', referenceRange: '30-100' },
  { name: 'X-Ray, chest, 2 view', code: 'XR-CHEST-2V', category: 'imaging', defaultUnit: null, referenceRange: null },
  { name: 'X-Ray, chest, 1 view', code: 'XR-CHEST-1V', category: 'imaging', defaultUnit: null, referenceRange: null },
  { name: 'X-Ray, wrist', code: 'XR-WRIST', category: 'imaging', defaultUnit: null, referenceRange: null },
  { name: 'X-Ray, knee', code: 'XR-KNEE', category: 'imaging', defaultUnit: null, referenceRange: null },
  { name: 'CT, head, without contrast', code: 'CT-HEAD-NC', category: 'imaging', defaultUnit: null, referenceRange: null },
  { name: 'Ultrasound, abdominal', code: 'US-ABD', category: 'imaging', defaultUnit: null, referenceRange: null },
]

async function seedLabTests() {
  const db = getDb()
  // Idempotent per-row by code -- insert only the codes not already present,
  // so this is safe to call unconditionally on every seed() run without
  // duplicating rows.
  const existing = await db.select({ code: labTests.code }).from(labTests)
  const existingCodes = new Set(existing.map((t) => t.code))
  const toInsert = LAB_TESTS_SEED.filter((t) => !existingCodes.has(t.code))
  if (toInsert.length > 0) await db.insert(labTests).values(toInsert)
}

// Best-effort payerId match for a claim's free-text payerName ("payerName
// contains payer.name"), the rule the original payer backfill used.
function matchPayerId(allPayers: { id: number; name: string }[], payerName: string): number | null {
  return allPayers.find((p) => payerName.toLowerCase().includes(p.name.toLowerCase()))?.id ?? null
}

// Medication catalogue: the psychiatry clinic's drugs plus a general-hospital
// formulary (Indian generics and strengths). `name` is the generic/clinical
// name used everywhere else in this file.
const MEDICATIONS_SEED: {
  name: string
  genericName: string | null
  medicationClass: string
  commonDose: string
  form: 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'
}[] = [
  { name: 'Sertraline', genericName: null, medicationClass: 'SSRI', commonDose: '50mg daily', form: 'tablet' },
  { name: 'Escitalopram', genericName: null, medicationClass: 'SSRI', commonDose: '10mg daily', form: 'tablet' },
  { name: 'Venlafaxine', genericName: null, medicationClass: 'SNRI', commonDose: '75mg daily', form: 'capsule' },
  { name: 'Bupropion', genericName: null, medicationClass: 'Atypical antidepressant', commonDose: '150mg daily', form: 'tablet' },
  { name: 'Trazodone', genericName: null, medicationClass: 'Atypical antidepressant', commonDose: '50mg at bedtime', form: 'tablet' },
  { name: 'Mirtazapine', genericName: null, medicationClass: 'Atypical antidepressant', commonDose: '15mg at bedtime', form: 'tablet' },
  { name: 'Aripiprazole', genericName: null, medicationClass: 'Atypical antipsychotic', commonDose: '5mg daily', form: 'tablet' },
  { name: 'Quetiapine', genericName: null, medicationClass: 'Atypical antipsychotic', commonDose: '100mg at bedtime', form: 'tablet' },
  { name: 'Risperidone', genericName: null, medicationClass: 'Atypical antipsychotic', commonDose: '2mg daily', form: 'tablet' },
  { name: 'Lorazepam', genericName: null, medicationClass: 'Benzodiazepine', commonDose: '0.5mg twice daily as needed', form: 'tablet' },
  { name: 'Clonazepam', genericName: null, medicationClass: 'Benzodiazepine', commonDose: '0.5mg twice daily', form: 'tablet' },
  { name: 'Methylphenidate ER', genericName: null, medicationClass: 'Stimulant', commonDose: '36mg daily', form: 'tablet' },
  { name: 'Amphetamine/dextroamphetamine', genericName: null, medicationClass: 'Stimulant', commonDose: '20mg daily', form: 'capsule' },
  { name: 'Lithium', genericName: null, medicationClass: 'Mood stabilizer', commonDose: '300mg twice daily', form: 'capsule' },
  { name: 'Esketamine', genericName: 'Spravato', medicationClass: 'NMDA antagonist', commonDose: '56mg per session', form: 'injection' },
  // Wave D: general-hospital formulary
  { name: 'Paracetamol 650 mg', genericName: null, medicationClass: 'Analgesic / antipyretic', commonDose: '650 mg three times daily', form: 'tablet' },
  { name: 'Pantoprazole 40 mg', genericName: null, medicationClass: 'Proton pump inhibitor', commonDose: '40 mg before breakfast', form: 'tablet' },
  { name: 'Metformin 500 mg', genericName: null, medicationClass: 'Biguanide', commonDose: '500 mg twice daily', form: 'tablet' },
  { name: 'Amlodipine 5 mg', genericName: null, medicationClass: 'Calcium channel blocker', commonDose: '5 mg once daily', form: 'tablet' },
  { name: 'Atorvastatin 10 mg', genericName: null, medicationClass: 'Statin', commonDose: '10 mg at night', form: 'tablet' },
  { name: 'Amoxicillin + Clavulanic acid 625 mg', genericName: null, medicationClass: 'Antibiotic', commonDose: '625 mg twice daily', form: 'tablet' },
  { name: 'Azithromycin 500 mg', genericName: null, medicationClass: 'Antibiotic', commonDose: '500 mg once daily for 3 days', form: 'tablet' },
  { name: 'Cetirizine 10 mg', genericName: null, medicationClass: 'Antihistamine', commonDose: '10 mg at night', form: 'tablet' },
  { name: 'Ceftriaxone 1 g injection', genericName: null, medicationClass: 'Antibiotic', commonDose: '1 g IV twice daily', form: 'injection' },
  { name: 'Ondansetron 4 mg injection', genericName: null, medicationClass: 'Antiemetic', commonDose: '4 mg IV as needed', form: 'injection' },
  { name: 'Oral rehydration salts (WHO)', genericName: null, medicationClass: 'Electrolyte replacement', commonDose: '1 sachet in 1 litre water', form: 'other' },
  { name: 'Salbutamol 100 mcg inhaler', genericName: null, medicationClass: 'Bronchodilator', commonDose: '2 puffs as needed', form: 'other' },
  // end Wave D
]

// Starting stock levels keyed by medication name -- a plausible starting
// point, not a clinically precise figure. Controlled substances get smaller
// on-hand quantities and tighter reorder thresholds.
const MEDICATION_INVENTORY_SEED: Record<string, { quantityOnHand: number; reorderThreshold: number; unit: string }> = {
  'Sertraline': { quantityOnHand: 150, reorderThreshold: 20, unit: 'tablets' },
  'Escitalopram': { quantityOnHand: 150, reorderThreshold: 20, unit: 'tablets' },
  'Venlafaxine': { quantityOnHand: 120, reorderThreshold: 15, unit: 'capsules' },
  'Bupropion': { quantityOnHand: 120, reorderThreshold: 15, unit: 'tablets' },
  'Trazodone': { quantityOnHand: 200, reorderThreshold: 20, unit: 'tablets' },
  'Mirtazapine': { quantityOnHand: 100, reorderThreshold: 15, unit: 'tablets' },
  'Aripiprazole': { quantityOnHand: 90, reorderThreshold: 15, unit: 'tablets' },
  'Quetiapine': { quantityOnHand: 100, reorderThreshold: 15, unit: 'tablets' },
  'Risperidone': { quantityOnHand: 90, reorderThreshold: 15, unit: 'tablets' },
  'Lorazepam': { quantityOnHand: 60, reorderThreshold: 10, unit: 'tablets' },
  'Clonazepam': { quantityOnHand: 60, reorderThreshold: 10, unit: 'tablets' },
  'Methylphenidate ER': { quantityOnHand: 60, reorderThreshold: 10, unit: 'tablets' },
  'Amphetamine/dextroamphetamine': { quantityOnHand: 60, reorderThreshold: 10, unit: 'capsules' },
  'Lithium': { quantityOnHand: 100, reorderThreshold: 15, unit: 'capsules' },
  'Esketamine': { quantityOnHand: 20, reorderThreshold: 10, unit: 'doses' },
  'Paracetamol 650 mg': { quantityOnHand: 2000, reorderThreshold: 300, unit: 'tablets' },
  'Pantoprazole 40 mg': { quantityOnHand: 800, reorderThreshold: 100, unit: 'tablets' },
  'Metformin 500 mg': { quantityOnHand: 1000, reorderThreshold: 150, unit: 'tablets' },
  'Amlodipine 5 mg': { quantityOnHand: 600, reorderThreshold: 100, unit: 'tablets' },
  'Atorvastatin 10 mg': { quantityOnHand: 600, reorderThreshold: 100, unit: 'tablets' },
  'Amoxicillin + Clavulanic acid 625 mg': { quantityOnHand: 300, reorderThreshold: 60, unit: 'tablets' },
  'Azithromycin 500 mg': { quantityOnHand: 150, reorderThreshold: 30, unit: 'tablets' },
  'Cetirizine 10 mg': { quantityOnHand: 400, reorderThreshold: 50, unit: 'tablets' },
  'Ceftriaxone 1 g injection': { quantityOnHand: 80, reorderThreshold: 20, unit: 'vials' },
  'Ondansetron 4 mg injection': { quantityOnHand: 12, reorderThreshold: 20, unit: 'ampoules' }, // below threshold: shows on the reorder list
  'Oral rehydration salts (WHO)': { quantityOnHand: 250, reorderThreshold: 50, unit: 'sachets' },
  'Salbutamol 100 mcg inhaler': { quantityOnHand: 30, reorderThreshold: 10, unit: 'inhalers' },
}

async function seedMedications() {
  const db = getDb()
  // Idempotent per-row: only insert medications/inventory rows that aren't
  // already present, so this is safe to call unconditionally on every seed()
  // run without duplicating catalog rows or violating medicationInventory's
  // one-row-per-medication unique constraint.
  const existingMeds = await db.select({ id: medications.id, name: medications.name }).from(medications)
  const existingNames = new Set(existingMeds.map((m) => m.name))
  const toInsert = MEDICATIONS_SEED.filter((m) => !existingNames.has(m.name))
  if (toInsert.length > 0) await db.insert(medications).values(toInsert)

  // Scoped to the intended catalogue (MEDICATIONS_SEED), not every row in
  // `medications`, so a stray row never gains inventory.
  const seededNames = new Set(MEDICATIONS_SEED.map((m) => m.name))
  const allMeds = await db.select({ id: medications.id, name: medications.name }).from(medications)
  const intendedMeds = allMeds.filter((m) => seededNames.has(m.name))
  const existingInventory = await db.select({ medicationId: medicationInventory.medicationId }).from(medicationInventory)
  const medsWithInventory = new Set(existingInventory.map((i) => i.medicationId))
  for (const med of intendedMeds) {
    if (medsWithInventory.has(med.id)) continue
    const stock = MEDICATION_INVENTORY_SEED[med.name] ?? { quantityOnHand: 50, reorderThreshold: 10, unit: 'units' }
    await db.insert(medicationInventory).values({ medicationId: med.id, ...stock })
  }
}

// Staff roster -- deliberately mixes three linkage shapes: some staff are both
// a system user AND a clinical provider, some are only one, and some (nursing/
// housekeeping) are neither. Matched by name against the demo `users` rows and
// the doctor roster, rather than hardcoded ids.
const STAFF_SEED: {
  name: string
  linkUserLocal: string | null  // local part of the seeded demo user's email
  linkProviderName: string | null
  department: string
  title: string
  employmentStatus: 'active' | 'on_leave' | 'terminated'
  hireDate: string
  terminationDate: string | null
}[] = [
  { name: 'Dr. Rajiv Kunam', linkUserLocal: 'pi', linkProviderName: 'Dr. Rajiv Kunam', department: 'Psychiatry', title: 'Consultant Psychiatrist', employmentStatus: 'active', hireDate: '2021-03-01', terminationDate: null },
  { name: 'Dr. Ananya Rao', linkUserLocal: null, linkProviderName: 'Dr. Ananya Rao', department: 'General Medicine', title: 'Consultant Physician', employmentStatus: 'active', hireDate: '2022-06-15', terminationDate: null },
  { name: 'Dr. Suresh Babu', linkUserLocal: 'pathologist', linkProviderName: 'Dr. Suresh Babu', department: 'Laboratory', title: 'Consultant Pathologist', employmentStatus: 'active', hireDate: '2019-01-10', terminationDate: null },
  { name: 'Jaya Raman', linkUserLocal: 'crc', linkProviderName: null, department: 'Clinical Research', title: 'Clinical Research Coordinator', employmentStatus: 'active', hireDate: '2022-09-01', terminationDate: null },
  { name: 'Sanjay Patil', linkUserLocal: 'admin', linkProviderName: null, department: 'Administration', title: 'Hospital Administrator', employmentStatus: 'active', hireDate: '2020-11-01', terminationDate: null },
  { name: 'Pooja Nair', linkUserLocal: 'frontdesk', linkProviderName: null, department: 'Front Office', title: 'Front Office Executive', employmentStatus: 'active', hireDate: '2023-04-20', terminationDate: null },
  { name: 'Sister Mary Joseph', linkUserLocal: null, linkProviderName: null, department: 'Nursing', title: 'Staff Nurse', employmentStatus: 'active', hireDate: '2018-07-01', terminationDate: null },
  { name: 'Lokesh M', linkUserLocal: null, linkProviderName: null, department: 'Housekeeping', title: 'Housekeeping Supervisor', employmentStatus: 'on_leave', hireDate: '2021-08-15', terminationDate: null },
  { name: 'Farida Shaikh', linkUserLocal: null, linkProviderName: null, department: 'Billing', title: 'Billing Executive', employmentStatus: 'terminated', hireDate: '2019-05-01', terminationDate: '2026-06-30' },
]

// Credential dates are computed relative to seed time, not hardcoded, so the
// 60-day warning window and the "already expired" state always have real
// demo data to show regardless of when this seed script actually runs.
function daysFromNow(days: number): string {
  return addDaysIso(todayIsoIn(), days)
}

const STAFF_CREDENTIALS_SEED: { staffName: string; credentialType: string; credentialNumber: string | null; expiresOn: string | null }[] = [
  { staffName: 'Dr. Rajiv Kunam', credentialType: 'Karnataka Medical Council registration', credentialNumber: 'DEMO/2008/41207', expiresOn: daysFromNow(400) },
  { staffName: 'Dr. Rajiv Kunam', credentialType: 'NDPS licence (controlled drugs)', credentialNumber: 'DEMO-NDPS-1123', expiresOn: daysFromNow(30) }, // inside the 60-day warning window
  { staffName: 'Dr. Ananya Rao', credentialType: 'NMC registration', credentialNumber: 'DEMO/NMC/2014/1188', expiresOn: daysFromNow(-15) }, // already expired
  { staffName: 'Dr. Ananya Rao', credentialType: 'ACLS certification', credentialNumber: 'DEMO-ACLS-88213', expiresOn: daysFromNow(500) },
  { staffName: 'Sister Mary Joseph', credentialType: 'Karnataka State Nursing Council registration', credentialNumber: 'DEMO-KNC-33012', expiresOn: daysFromNow(200) },
  { staffName: 'Sister Mary Joseph', credentialType: 'BLS certification', credentialNumber: 'DEMO-BLS-9988', expiresOn: daysFromNow(55) }, // inside the 60-day warning window
]

async function seedStaff() {
  const db = getDb()
  const existingStaff = await db.select({ name: staffMembers.name }).from(staffMembers)
  const existingNames = new Set(existingStaff.map((s) => s.name))
  const toInsert = STAFF_SEED.filter((s) => !existingNames.has(s.name))
  if (toInsert.length === 0) return

  const allUsers = await db.select({ id: users.id, email: users.email }).from(users)
  const userByEmail = new Map(allUsers.map((u) => [u.email, u.id]))
  const allProviders = await db.select({ id: providers.id, name: providers.name }).from(providers)
  const providerByName = new Map(allProviders.map((p) => [p.name, p.id]))

  const inserted = await db.insert(staffMembers).values(toInsert.map((s) => ({
    name: s.name,
    userId: s.linkUserLocal ? (userByEmail.get(seedEmail(s.linkUserLocal)) ?? null) : null,
    providerId: s.linkProviderName ? (providerByName.get(s.linkProviderName) ?? null) : null,
    department: s.department,
    title: s.title,
    employmentStatus: s.employmentStatus,
    hireDate: s.hireDate,
    terminationDate: s.terminationDate,
  }))).returning()

  const staffIdByName = new Map(inserted.map((s) => [s.name, s.id]))
  const credentialRows = STAFF_CREDENTIALS_SEED
    .filter((c) => staffIdByName.has(c.staffName))
    .map((c) => ({ staffMemberId: staffIdByName.get(c.staffName)!, credentialType: c.credentialType, credentialNumber: c.credentialNumber, expiresOn: c.expiresOn }))
  if (credentialRows.length > 0) await db.insert(staffCredentials).values(credentialRows)
}

// Legacy (pre-SP4) charge workflow and its A/R, kept so the legacy charges,
// claims and statements screens still demonstrate every status. Amounts are
// INR paise and codes are the hospital's service codes (no CPT).
const psych = (code: string, description: string, paise: number, units = 1) => ({ code, description, units, chargeCents: paise * units })
const CONS = () => psych('CONS_PSYCH', 'Consultation - Psychiatry', 800_00)
const THERAPY = (units = 1) => psych('PSY_THERAPY', 'Psychotherapy session (60 minutes)', 1_500_00, units)
const REVIEW = () => psych('PSY_REVIEW', 'Psychiatry review consultation', 600_00)

async function seedBilling() {
  const db = getDb()
  const allPayers = await db.select({ id: payers.id, name: payers.name }).from(payers)
  const dx = {
    mddRec: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
    mddSingle: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
    adhd: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
  }
  const line = (patientId: string, dateOfService: string, status: 'draft' | 'pending_approval' | 'approved' | 'submitted', diagnosisCodes: { code: string; description: string }[], proc: ReturnType<typeof psych>) => ({
    patientId, providerName: 'Dr. R. Kunam', dateOfService, status, diagnosisCodes, procedureCodes: [proc], amountCents: proc.chargeCents,
  })

  const chargeRows = await db.insert(charges).values([
    // Workflow-state charges (not yet submitted -- excluded from A/R).
    line('RD-0001', '2026-09-14', 'draft', dx.mddRec, THERAPY()),
    line('RD-0002', '2026-09-12', 'pending_approval', dx.mddSingle, CONS()),
    line('RD-0003', '2026-09-10', 'pending_approval', dx.mddSingle, REVIEW()),
    line('RD-0004', '2026-09-08', 'approved', dx.adhd, CONS()),
    line('RD-0005', '2026-09-06', 'approved', dx.adhd, THERAPY()),
    // Submitted charges -- what the A/R dashboard and patient collections aggregate.
    // One per aging bucket, plus a second 0-30 charge (RD-0005) used to show an
    // overpayment/unapplied amount via a mock payment below.
    line('RD-0001', '2026-09-05', 'submitted', dx.mddRec, THERAPY()),
    line('RD-0002', '2026-08-10', 'submitted', dx.mddSingle, CONS()),
    line('RD-0003', '2026-07-05', 'submitted', dx.mddSingle, REVIEW()),
    line('RD-0006', '2026-05-25', 'submitted', dx.mddRec, THERAPY(2)),
    line('RD-0004', '2026-03-01', 'submitted', dx.adhd, REVIEW()),
    line('RD-0005', '2026-09-01', 'submitted', dx.adhd, CONS()),
  ]).returning()

  const byDos = (dos: string) => chargeRows.find((c) => c.dateOfService === dos)!
  const c1 = byDos('2026-09-05')
  const c2 = byDos('2026-08-10')
  const c3 = byDos('2026-07-05')
  const c6 = byDos('2026-05-25')
  const c4 = byDos('2026-03-01')
  const c5 = byDos('2026-09-01')

  const claim = (c: typeof c1, payerName: string, status: 'rejected' | 'denied' | 'waiting_adjudication' | 'needs_investigation' | 'paid', paid: number | null, notes?: string) => ({
    chargeId: c.id, patientId: c.patientId, payerName, payerId: matchPayerId(allPayers, payerName), billedAmountCents: c.amountCents,
    paidAmountCents: paid, status, submittedDate: c.dateOfService, ...(notes ? { notes } : {}),
  })
  await db.insert(insuranceClaims).values([
    claim(c1, 'Star Health and Allied Insurance', 'paid', c1.amountCents),
    claim(c2, 'ICICI Lombard General Insurance', 'waiting_adjudication', null),
    claim(c3, 'Medi Assist TPA', 'denied', 0, 'Outpatient psychiatry not covered under the policy.'),
    claim(c6, 'HDFC ERGO General Insurance', 'needs_investigation', null, 'Insurer requesting the discharge summary and prescriptions.'),
    claim(c4, 'Niva Bupa Health Insurance', 'rejected', 0, 'Policy number does not match the member ID card.'),
  ])

  // Two mock card payments: one Luhn-valid ("success"), one Luhn-invalid
  // ("failed"). The success payment (RD-0005, ₹1,000.00) exceeds its charge's
  // ₹800.00 balance on purpose, so Patient Collections has a non-zero
  // "unapplied" amount to show (₹200.00).
  await db.insert(mockPayments).values([
    { patientId: 'RD-0005', chargeId: c5.id, amountCents: 1_000_00, cardLast4: '4242', expMonth: 12, expYear: 2027, result: 'success', createdAt: new Date('2026-09-02T11:00:00+05:30') },
    { patientId: 'RD-0003', chargeId: c3.id, amountCents: c3.amountCents, cardLast4: '4444', expMonth: 1, expYear: 2028, result: 'failed', createdAt: new Date('2026-07-10T11:00:00+05:30') },
  ])

  await db.insert(patientStatements).values([
    { patientId: 'RD-0002', amountCents: c2.amountCents, deliveryMethod: 'email', type: 'reminder', deliveryStatus: 'delivered', sentDate: new Date('2026-08-15T10:00:00+05:30') },
    { patientId: 'RD-0003', amountCents: c3.amountCents, deliveryMethod: 'paper', type: 'initial', deliveryStatus: 'delivered', sentDate: new Date('2026-07-10T10:00:00+05:30') },
    { patientId: 'RD-0006', amountCents: c6.amountCents, deliveryMethod: 'sms', type: 'final_notice', deliveryStatus: 'failed', sentDate: new Date('2026-08-25T10:00:00+05:30') },
    { patientId: 'RD-0004', amountCents: c4.amountCents, deliveryMethod: 'email', type: 'reminder', deliveryStatus: 'delivered', sentDate: new Date('2026-09-01T10:00:00+05:30') },
  ])
}

// Spreads a few appointments (relative to today, IST) across the roster for
// databases topped up rather than rebuilt. Idempotent: skips any patient that
// already has an appointment on file.
async function seedAdditionalAppointmentsForExpandedRoster() {
  const db = getDb()
  const rosterProviders = await db.select().from(providers)
  if (rosterProviders.length === 0) return

  const VISIT_REASONS = ['New patient consultation', 'Medication review', 'Follow-up visit', 'Blood pressure review', 'Diabetes review', 'Report review']
  const today = todayIsoIn()
  let dayOffset = 1

  for (let i = 12; i < FILLER_PROFILES.length; i++) {
    const id = `RD-${String(7 + i).padStart(4, '0')}`
    const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))
    if (!patient) continue // this id was skipped in seedFillerPatients (e.g. a real user-created patient already occupies it)
    if (i % 2 !== 0) continue // spread appointments across roughly half of the roster, not every patient

    const [existingAppt] = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.patientId, id))
    if (existingAppt) continue

    const provider = rosterProviders[i % rosterProviders.length]
    const startsAt = new Date(`${addDaysIso(today, dayOffset % 14)}T${String(9 + (i % 6)).padStart(2, '0')}:00:00+05:30`)
    dayOffset += 1

    await db.insert(appointments).values({
      patientId: id,
      providerId: provider.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 15 * 60 * 1000),
      visitReason: VISIT_REASONS[i % VISIT_REASONS.length],
      status: 'scheduled',
    })
  }
}

// SP5: default home-collection windows ('HH:MM' IST). The demo service-area
// PINs are added only by the demo operations (seed-india.ts); real sites set
// their own in Settings -> Lab setup.
const HOME_COLLECTION_WINDOWS_SEED = [
  { label: 'Early morning', startTime: '07:00', endTime: '09:00', capacity: 10, sortOrder: 1 },
  { label: 'Morning', startTime: '09:00', endTime: '11:00', capacity: 10, sortOrder: 2 },
  { label: 'Late morning', startTime: '11:00', endTime: '13:00', capacity: 8, sortOrder: 3 },
]

async function seedHomeCollectionWindows() {
  await getDb().insert(homeCollectionWindows).values(HOME_COLLECTION_WINDOWS_SEED)
}
// end SP5

/** Removes the legacy US payers a reset leaves unreferenced (any still referenced elsewhere are kept). */
async function removeLegacyUsPayers() {
  const db = getDb()
  for (const name of LEGACY_US_PAYER_NAMES) {
    try {
      await db.delete(payers).where(eq(payers.name, name))
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code !== '23503') throw err
    }
  }
}

async function clearExistingData() {
  const db = getDb()
  // Delete in FK-safe order (children before parents) so seed() is safely re-runnable
  // against the live database without unique-constraint violations.
  // tests/db/seed-clear-existing-data-fk-order.test.ts checks this order against every
  // foreign key in the schema, so a new child table must be added here.
  // SP4: billing documents and charge lines go first (charge lines reference charges,
  // medication_dispenses, encounters, admissions, service_catalog and tariff_rates).
  // Issued documents are guarded by the migration-B immutability triggers, so they are
  // cleared children-first in one transaction that sets the transaction-local purge flag.
  // Rule config is cleared; the billing_settings singleton is kept, but its room-rent
  // service link is released before service_catalog is deleted below.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    // SP8: NHCX exchanges reference claims, claim versions, pre-auths, queries, policies and
    // eligibility checks; eligibility checks reference policies and payers; consents and shares
    // reference patients. Inbound calls and consents are append-only (purge flag above).
    await tx.delete(nhcxInboundCalls)
    await tx.delete(nhcxExchanges)
    await tx.delete(nhcxEligibilityChecks)
    await tx.delete(abdmProfileShares)
    await tx.delete(abdmConsents)
    // end SP8
    // SP7: claims and pre-auths reference invoices, policies, encounters, admissions, users and
    // charge lines reference pre-auths, so they go first, in purgeRcmFixtures' order.
    await tx.delete(claimWriteOffs)
    await tx.delete(claimSettlements)
    await tx.delete(claimDisallowances)
    await tx.delete(claimDocuments)
    await tx.delete(preauthDocuments)
    await tx.delete(rcmQueryResponses)
    await tx.delete(rcmQueries)
    await tx.delete(claimEvents)
    await tx.delete(claimDispatches)
    await tx.delete(claimSubmissions)
    await tx.delete(claimInvoices)
    await tx.update(chargeLines).set({ preauthId: null })
    await tx.delete(claims)
    await tx.delete(preauthEvents)
    await tx.delete(preauths)
    // end SP7
    await tx.delete(refunds)
    await tx.delete(patientPayments)
    await tx.delete(creditNotes)
    await tx.delete(invoiceLines)
    await tx.delete(chargeLines)
    await tx.delete(invoices)
    await tx.delete(documentCounters)
  })
  await db.delete(chargeRuleConfigs)
  await db.update(billingSettings).set({ roomRentServiceId: null })
  // end SP4
  // Wave D: everything else that hangs off appointments, admissions, rooms and medication
  // episodes, children first.
  await db.delete(telemedicineSignals)
  await db.delete(telemedicineSessions)
  await db.delete(bookingRequests)
  await db.delete(medicationAdministrations)
  await db.delete(medicationDispenses)
  await db.delete(admissionTransfers)
  await db.delete(encounterNotes)
  await db.delete(signatures)
  await db.delete(policyDocuments)
  await db.delete(messages)
  await db.delete(insuranceEligibilityChecks)
  await db.delete(carePlanGoals)
  await db.delete(carePlans)
  await db.delete(adverseEvents)
  await db.delete(drugAccountabilityEntries)
  await db.delete(regulatoryDocuments)
  // end Wave D
  await db.delete(faxes)
  await db.delete(documents)
  await db.delete(mockPayments)
  await db.delete(patientStatements)
  await db.delete(insuranceClaims)
  await db.delete(charges)
  await db.delete(reviews)
  await db.delete(broadcasts)
  await db.delete(screeningCriteriaResults)
  await db.delete(patientTrialScreenings)
  await db.delete(medicationEpisodes)
  await db.delete(diagnoses)
  await db.delete(formSubmissionScores)
  await db.delete(formChartDiscrepancies)
  // form_submission_consents and form_template_consents reference
  // form_submissions / form_templates / consent_documents with no ON DELETE
  // action, so both join tables go before any of their parents.
  await db.delete(formSubmissionConsents)
  await db.delete(formSubmissions)
  await db.delete(allergies)
  await db.delete(identityVerifications)
  // SP1 child tables of patients (no ON DELETE action).
  await db.delete(patientContacts)
  await db.delete(patientAadhaar)
  await db.delete(appSettings)
  await db.delete(formTemplateConsents)
  await db.delete(formTemplates)
  // form_templates.folder_id references form_template_folders.
  await db.delete(formTemplateFolders)
  await db.delete(consentDocuments)
  // SP5: mirrors deletePatient's order -- deliveries and reports, then results -> orders, then
  // visits -> requisitions, then the reference windows/PINs -- all before patients/users.
  await db.delete(notificationDeliveries)
  await db.delete(labReports)
  await db.delete(labResults)
  await db.delete(labOrders)
  await db.delete(homeCollectionVisits)
  await db.delete(labRequisitions)
  await db.delete(homeCollectionWindows)
  await db.delete(labServiceAreaPins)
  // end SP5
  // SP3: contact attempts -> follow-up orders -> encounters, all before appointments/patients.
  await db.delete(followUpContactAttempts)
  await db.delete(followUpOrders)
  // SP6: coding workflow rows reference encounters (diagnoses were cleared above). Code
  // systems and codes are owner-loaded reference data and are never cleared here.
  await db.delete(codingQueryResponses)
  await db.delete(codingQueries)
  await db.delete(encounterCodingEvents)
  await db.delete(encounterCoding)
  await db.delete(encounterProcedures)
  // end SP6
  await db.delete(encounters)
  // Wave D: an admission references its doctor assignment, appointment and room.
  await db.delete(admissions)
  await db.delete(doctorAssignments)
  await db.delete(rooms)
  // end Wave D
  await db.delete(appointments)
  // SP7: policies reference patients and payers. The payer master (payers and their SP7
  // profiles, networks, contacts, requirements) and reason codes are reference data and are
  // never cleared here, like payers themselves.
  await db.delete(patientPolicies)
  await db.delete(patients)
  // staffCredentials/staffMembers FK into providers/users, so both must be
  // deleted before providers/users below.
  await db.delete(staffCredentials)
  await db.delete(staffMembers)
  await db.delete(providers)
  // SP2: service_catalog references departments; room_categories is
  // referenced by rooms, which were already deleted above.
  // tariff_rates and service_package_items reference service_catalog.
  // SP5: lab_tests survive the clear (seedLabTests tops them up) but may point at a service.
  await db.update(labTests).set({ serviceId: null })
  await db.delete(serviceProcedureCodes) // SP6: references service_catalog
  await db.delete(tariffRates)
  await db.delete(servicePackageItems)
  await db.delete(serviceCatalog)
  await db.delete(roomCategories)
  await db.delete(departments)
  await db.delete(users)
  await db.delete(trials)
  await removeLegacyUsPayers() // Wave D
  await restartEmptyIdSequences() // Wave D
}

/**
 * Wave D: after a reset, every table the clear emptied numbers from 1 again, so a rebuilt demo
 * has the same ids and document numbers as a freshly seeded one. Only sequences of tables that
 * are now empty are touched (reference data that survives the clear, and uhid_seq, keep counting).
 */
async function restartEmptyIdSequences() {
  await getDb().execute(sql.raw(`DO $$
DECLARE r record; is_empty boolean;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, s.relname AS seq
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
    JOIN pg_class c ON c.oid = d.refobjid
    WHERE s.relkind = 'S' AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM public.%I)', r.tbl) INTO is_empty;
    IF is_empty THEN EXECUTE format('ALTER SEQUENCE public.%I RESTART WITH 1', r.seq); END IF;
  END LOOP;
  -- Document-number sequences that no column owns: lab report, pre-auth and claim numbers.
  FOR r IN SELECT * FROM (VALUES ('lab_reports', 'lab_report_seq'), ('preauths', 'preauth_number_seq'), ('claims', 'claim_number_seq')) AS v(tbl, seq)
  LOOP
    EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM public.%I)', r.tbl) INTO is_empty;
    IF is_empty THEN EXECUTE format('ALTER SEQUENCE public.%I RESTART WITH 1', r.seq); END IF;
  END LOOP;
END $$;`))
}

async function insertHeroPatient(p: HeroPatient) {
  const db = getDb()
  await db.insert(patients).values({
    id: p.id,
    name: p.name,
    dob: p.dob,
    phone: syntheticMobile(p.phoneIndex),
    email: p.email,
    currentProvider: p.provider,
    ratingScales: [p.ratingScale],
    referralType: 'Doctor referral',
    availability: 'Weekday mornings',
    commConsentSigned: true,
    commConsentPref: 'Phone',
    ...(await indianPatientColumns(p, p.placeIndex, Number(p.id.slice(3)), Number(p.id.slice(3)))),
  })

  await db.insert(diagnoses).values({ patientId: p.id, code: p.diagnosisCode.code, description: p.diagnosisCode.description, date: '2025-01-15' })
  if (p.activeMed.name !== 'Unknown' && p.activeMed.name !== 'None') {
    await db.insert(medicationEpisodes).values({ patientId: p.id, name: p.activeMed.name, medicationClass: p.activeMed.medicationClass, dose: p.activeMed.dose, startDate: p.activeMed.startDate, status: 'active' })
  }

  const screening = await db.insert(patientTrialScreenings).values({ patientId: p.id, trialId: p.trialId, overallStatus: p.overallStatus }).returning()
  for (const c of p.criteria) {
    await db.insert(screeningCriteriaResults).values({ screeningId: screening[0].id, criterionKey: c.key, criterionText: c.text, criterionType: EXCLUSION_CRITERION_KEYS.has(c.key) ? 'exclusion' : 'inclusion', verdict: c.verdict, evidenceQuote: c.quote, evidenceSourceDoc: c.sourceDoc, evidenceSourceDate: c.sourceDate })
  }
}

/** Reference data and safe top-ups for a database that already has patients (no deletes). */
async function topUpExistingDatabase(count: number) {
  const db = getDb()
  console.log(`Seed: patients table already has ${count} row(s); topping up reference data only. Set SEED_RESET=1 to rebuild the demo.`)
  await seedIndiaReference(SEED_ACTOR)
  console.log('Topped up the India masters (departments, payers, wards, services and tariffs, doctors, UHIDs).')
  // Staff directory links to both `users` and `providers` by name, so it
  // must run after the doctors above.
  const [{ staffCount }] = await db.select({ staffCount: sql<number>`count(*)::int` }).from(staffMembers)
  if (staffCount === 0) {
    await seedStaff()
    console.log('Seeded staff directory (patients table was already populated).')
  }
  // seedFillerPatients() skips any id that already exists, so it's safe to
  // call again here to top up the roster.
  await seedFillerPatients()
  await seedAdditionalAppointmentsForExpandedRoster()

  const [{ chargeCount }] = await db.select({ chargeCount: sql<number>`count(*)::int` }).from(charges)
  if (chargeCount === 0) {
    await seedBilling()
    console.log('Seeded legacy billing (charges/claims/payments/statements) (patients table was already populated).')
  }
  const [{ documentCount }] = await db.select({ documentCount: sql<number>`count(*)::int` }).from(documents)
  if (documentCount === 0) {
    await seedDocumentsAndFaxes()
    console.log('Seeded documents/faxes (patients table was already populated).')
  }
}

export async function seed(opts: { reset?: boolean } = {}) {
  assertSeedAllowed()
  const db = getDb()
  const reset = opts.reset ?? seedResetRequested()

  // Medication catalogue + inventory and the lab test catalogue are standalone
  // reference data, idempotent per row, so they are topped up on every run.
  await seedMedications()
  await seedLabTests()

  // A database that already has patients is only topped up (never cleared)
  // unless SEED_RESET=1 asks for a full rebuild of the demo.
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(patients)
  if (count > 0 && !reset) {
    await topUpExistingDatabase(count)
    return
  }

  // Checked before anything is deleted, so a missing password never leaves a half-cleared database.
  const demoHash = hashPassword(seedDemoPassword())
  if (count > 0) console.log(`SEED_RESET=1: clearing ${count} existing patient(s) and the demo data around them.`)
  await clearExistingData()

  await db.insert(trials).values([MDD_TRIAL, ADHD_TRIAL])
  await seedHomeCollectionWindows() // SP5

  // Demo credentials for each staff role, so login isn't admin-only. The
  // real admin account authenticates via ADMIN_EMAIL/ADMIN_PASSWORD_HASH,
  // never through this table -- the admin row here is inert demo data.
  // Emails use SEED_EMAIL_DOMAIN and the password is SEED_DEMO_PASSWORD;
  // neither lives in source.
  const insertedUsers = await db.insert(users).values(DEMO_USERS.map((u) => ({ name: u.name, email: seedEmail(u.local), role: u.role, passwordHash: demoHash }))).returning({ id: users.id, email: users.email, name: users.name, role: users.role })
  const sessionFor = (local: string): Session => {
    const u = insertedUsers.find((r) => r.email === seedEmail(local))!
    return { role: u.role, name: u.name, userId: u.id }
  }

  // Settings row (auto-classify off) and the hospital's identity, before any UHID is issued.
  await db.insert(appSettings).values({ autoClassifyOnComplete: false, practiceName: DEMO_HOSPITAL.legalName, practiceSite: 'Bengaluru' })

  const refs: IndiaRefs = await seedIndiaReference(SEED_ACTOR)
  console.log('Seeded the India masters (departments, doctors, payers, wards, services and tariffs, lab tests, sample code sets).')

  for (const p of HERO_PATIENTS) await insertHeroPatient(p)
  await seedFillerPatients()

  const fillerIds = FILLER_PROFILES.map((_, i) => `RD-${String(7 + i).padStart(4, '0')}`)
  const heroIds = HERO_PATIENTS.map((p) => p.id)
  // Synthetic Aadhaar (encrypted, consented) for a dozen patients; recorded declines for two.
  await seedAadhaar([...heroIds, ...fillerIds.slice(0, 8)], [{ id: fillerIds[8], reason: 'patient_declined' }, { id: fillerIds[9], reason: 'not_available' }], SEED_ACTOR)
  await seedContacts([...heroIds, ...fillerIds.slice(0, 14)])
  // Patient portal access for two demo patients (same demo password as staff).
  for (const id of ['RD-0001', 'RD-0004']) await setPatientPortalPassword(id, seedDemoPassword())

  await seedStaff()
  await seedBilling()
  await seedDocumentsAndFaxes()
  await seedTrialCompliance()

  // Demo-only prescribed episodes (prescribedAt IS NOT NULL) for the first
  // hero patient, so the print view and prescriber attribution have real
  // data. This patient's imported-history episode inserted above is left with
  // prescribedAt null on purpose (see schema.ts on medicationEpisodes).
  const heroPrescriberId = refs.providerIds.get('Dr. Rajiv Kunam')
  const heroPatientId = HERO_PATIENTS[0].id
  await db.insert(medicationEpisodes).values([
    {
      patientId: heroPatientId,
      name: 'Fluoxetine',
      medicationClass: 'SSRI/SNRI antidepressant',
      dose: '20mg daily',
      startDate: '2026-08-01',
      status: 'active',
      frequencyPerDay: 2,
      durationDays: 30,
      instructions: 'Take with food.',
      prescribedByProviderId: heroPrescriberId,
      enteredByName: 'Dr. Rajiv Kunam',
      prescribedAt: new Date(),
    },
    {
      patientId: heroPatientId,
      name: 'Buspirone',
      medicationClass: 'Anxiolytic',
      dose: '15mg daily',
      startDate: '2026-08-01',
      status: 'active',
      frequencyPerDay: 1,
      durationDays: 90,
      instructions: null,
      prescribedByProviderId: heroPrescriberId,
      enteredByName: 'Dr. Rajiv Kunam',
      prescribedAt: new Date(),
    },
  ])

  // Form templates: one per trial condition, each with a handful of
  // realistic intake questions including at least one hipaaSensitive field.
  const [mddTemplate] = await db.insert(formTemplates).values({
    name: 'MDD Intake Packet',
    category: 'Trial Intake',
    diagnosisTag: 'Major Depressive Disorder',
    questions: [
      { id: 'q1', label: 'Full legal name', type: 'text', hipaaSensitive: true, required: true, autofillField: 'name' },
      { id: 'q2', label: 'Date of birth', type: 'date', hipaaSensitive: true, required: true, autofillField: 'dob' },
      { id: 'q3', label: 'Current mood symptoms (describe)', type: 'textarea', hipaaSensitive: true, required: true },
      { id: 'q4', label: 'Currently taking antidepressants?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: true, required: true, compareToChart: { type: 'medication_active', medicationClass: 'SSRI/SNRI antidepressant' } },
      { id: 'q5', label: 'Consent to share records with study team', type: 'checkbox', hipaaSensitive: false, required: true },
    ],
  }).returning()

  const [adhdTemplate] = await db.insert(formTemplates).values({
    name: 'ADHD Intake Packet',
    category: 'Trial Intake',
    diagnosisTag: 'ADHD',
    questions: [
      { id: 'q1', label: 'Full legal name', type: 'text', hipaaSensitive: true, required: true, autofillField: 'name' },
      { id: 'q2', label: 'Date of birth', type: 'date', hipaaSensitive: true, required: true, autofillField: 'dob' },
      { id: 'q3', label: 'Current stimulant medication (if any)', type: 'text', hipaaSensitive: true, required: false, compareToChart: { type: 'medication_active', medicationClass: 'Stimulant' } },
      { id: 'q4', label: 'Consent to share records with study team', type: 'checkbox', hipaaSensitive: false, required: true },
    ],
  }).returning()

  // Non-trial-specific templates, matching IntakeQ's Consent Forms / Screening
  // Questionnaires / Note Templates folders (adapted to what a trial
  // pre-screening pilot actually needs, not a full outpatient-practice clone).
  await db.insert(formTemplates).values([
    {
      name: 'General Research Consent',
      category: 'Consent Forms',
      diagnosisTag: 'General',
      questions: [
        { id: 'q1', label: 'I consent to my de-identified data being used for research purposes', type: 'checkbox', hipaaSensitive: false, required: true },
        { id: 'q2', label: 'Signature (typed full name)', type: 'text', hipaaSensitive: true, required: true },
        { id: 'q3', label: 'Date', type: 'date', hipaaSensitive: false, required: true },
      ],
    },
    {
      name: 'Telehealth Consent',
      category: 'Consent Forms',
      diagnosisTag: 'General',
      questions: [
        { id: 'q1', label: 'I consent to receiving care via telehealth', type: 'checkbox', hipaaSensitive: false, required: true },
        { id: 'q2', label: 'Signature (typed full name)', type: 'text', hipaaSensitive: true, required: true },
      ],
    },
    {
      name: 'PHQ-9 (Depression Screening)',
      category: 'Screening Questionnaires',
      diagnosisTag: 'Major Depressive Disorder',
      questions: [
        { id: 'q1', label: 'Little interest or pleasure in doing things', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q2', label: 'Feeling down, depressed, or hopeless', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q3', label: 'Trouble falling or staying asleep, or sleeping too much', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q4', label: 'Feeling tired or having little energy', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q5', label: 'Poor appetite or overeating', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q6', label: 'Feeling bad about yourself — or that you are a failure or have let yourself or your family down', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q7', label: 'Trouble concentrating on things, such as reading or watching television', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q8', label: 'Moving or speaking so slowly that other people could have noticed, or the opposite — being so fidgety or restless that you have been moving around a lot more than usual', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q9', label: 'Thoughts that you would be better off dead, or of hurting yourself in some way', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
      ],
      scoringRule: { questionIds: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9'], bands: [{ min: 0, max: 4, label: 'Minimal' }, { min: 5, max: 9, label: 'Mild' }, { min: 10, max: 14, label: 'Moderate' }, { min: 15, max: 19, label: 'Moderately Severe' }, { min: 20, max: 27, label: 'Severe' }] },
    },
    {
      name: 'ASRS-v1.1 (ADHD Screening)',
      category: 'Screening Questionnaires',
      diagnosisTag: 'ADHD',
      questions: [
        { id: 'q1', label: 'How often do you have trouble wrapping up the final details of a project?', type: 'select', options: ['Never', 'Rarely', 'Sometimes', 'Often', 'Very Often'], hipaaSensitive: true, required: true },
      ],
    },
    {
      name: 'GAD-7 (Anxiety Screening)',
      category: 'Screening Questionnaires',
      diagnosisTag: 'Generalized Anxiety Disorder',
      questions: [
        { id: 'q1', label: 'Feeling nervous, anxious, or on edge', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q2', label: 'Not being able to stop or control worrying', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q3', label: 'Worrying too much about different things', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q4', label: 'Trouble relaxing', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q5', label: "Being so restless that it's hard to sit still", type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q6', label: 'Becoming easily annoyed or irritable', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
        { id: 'q7', label: 'Feeling afraid as if something awful might happen', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
      ],
      scoringRule: { questionIds: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'], bands: [{ min: 0, max: 4, label: 'Minimal' }, { min: 5, max: 9, label: 'Mild' }, { min: 10, max: 14, label: 'Moderate' }, { min: 15, max: 21, label: 'Severe' }] },
    },
  ])

  // Form submissions: a spread of sent/partial/completed across seeded patients.
  const heroName = (id: string) => hero(id).name
  await db.insert(formSubmissions).values([
    { templateId: mddTemplate.id, patientId: 'RD-0001', status: 'completed', sentDate: new Date('2026-08-10T10:00:00+05:30'), completedDate: new Date('2026-08-15T10:00:00+05:30'), answers: { q1: heroName('RD-0001'), q4: 'Yes' } },
    { templateId: mddTemplate.id, patientId: 'RD-0002', status: 'completed', sentDate: new Date('2026-08-16T10:00:00+05:30'), completedDate: new Date('2026-08-20T10:00:00+05:30'), answers: { q1: heroName('RD-0002'), q4: 'Yes' } },
    { templateId: mddTemplate.id, patientId: 'RD-0003', status: 'sent', sentDate: new Date('2026-08-25T10:00:00+05:30') },
    { templateId: mddTemplate.id, patientId: 'RD-0006', status: 'partial', sentDate: new Date('2026-08-18T10:00:00+05:30'), answers: { q1: heroName('RD-0006') } },
    { templateId: adhdTemplate.id, patientId: 'RD-0004', status: 'completed', sentDate: new Date('2026-08-17T10:00:00+05:30'), completedDate: new Date('2026-08-22T10:00:00+05:30'), answers: { q1: heroName('RD-0004') } },
    { templateId: adhdTemplate.id, patientId: 'RD-0005', status: 'sent', sentDate: new Date('2026-08-24T10:00:00+05:30') },
  ])

  // Allergies for a subset of patients.
  await db.insert(allergies).values([
    { patientId: 'RD-0001', allergen: 'Penicillin', reaction: 'Rash', severity: 'moderate' },
    { patientId: 'RD-0002', allergen: 'Sulfa drugs', reaction: 'Hives', severity: 'severe' },
    { patientId: 'RD-0006', allergen: 'Latex', reaction: 'Contact dermatitis', severity: 'mild' },
  ])

  // KYC identity documents (never Aadhaar, which has its own consented flow): a mix of
  // verified and pending. The numbers are made-up formats, encrypted at rest.
  await db.insert(identityVerifications).values([
    { patientId: 'RD-0001', idType: 'drivers_license', idNumberEncrypted: encryptSensitive('KA0120110012345'), verified: true, verifiedBy: 'Jaya Raman', verifiedAt: new Date('2026-08-16T10:00:00+05:30') },
    { patientId: 'RD-0002', idType: 'pan', idNumberEncrypted: encryptSensitive('ZZZPZ9999Z'), verified: true, verifiedBy: 'Jaya Raman', verifiedAt: new Date('2026-08-21T10:00:00+05:30') },
    { patientId: 'RD-0003', idType: 'passport', idNumberEncrypted: encryptSensitive('Z9988776'), verified: false },
  ])

  // Phase 5: stagger dateAdded/chartDataAsOf for a handful of patients so the
  // Pipeline Performance Dashboard's date-range filters and "average days
  // referral -> classification" KPI have real spread to show.
  const now = new Date()
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)
  await db.update(patients).set({ dateAdded: daysAgo(35), chartDataAsOf: daysAgo(28) }).where(eq(patients.id, 'RD-0001'))
  await db.update(patients).set({ dateAdded: daysAgo(20), chartDataAsOf: daysAgo(15) }).where(eq(patients.id, 'RD-0002'))
  await db.update(patients).set({ dateAdded: daysAgo(12), chartDataAsOf: daysAgo(9) }).where(eq(patients.id, 'RD-0003'))
  await db.update(patients).set({ dateAdded: daysAgo(8), chartDataAsOf: daysAgo(6) }).where(eq(patients.id, 'RD-0004'))
  await db.update(patients).set({ dateAdded: daysAgo(3), chartDataAsOf: daysAgo(1) }).where(eq(patients.id, 'RD-0005'))
  await db.update(patients).set({ dateAdded: daysAgo(2) }).where(eq(patients.id, 'RD-0006')) // not yet (re)classified

  // Broadcasts: a spread of channels, filters, and simulated delivery outcomes.
  await db.insert(broadcasts).values([
    {
      message: 'Reminder: your study intake packet is still open. Please finish it before your next visit.',
      channel: 'sms',
      filterTrialId: 'nct06911112',
      filterOverallStatus: 'yellow',
      filterFormStatus: null,
      recipients: [
        { patientId: 'RD-0003', patientName: heroName('RD-0003'), deliveryStatus: 'delivered' },
        { patientId: 'RD-0006', patientName: heroName('RD-0006'), deliveryStatus: 'delivered' },
      ],
      recipientCount: 2,
      sentBy: 'Jaya Raman',
      sentAt: daysAgo(10),
    },
    {
      subject: 'Your ADHD study forms are complete — next steps',
      message: 'Thank you for completing your intake packet. The study coordinator will call you within 2 working days to schedule your screening visit.',
      channel: 'email',
      filterTrialId: 'nct-adhd-demo-01',
      filterOverallStatus: null,
      filterFormStatus: 'completed',
      recipients: [
        { patientId: 'RD-0004', patientName: heroName('RD-0004'), deliveryStatus: 'delivered' },
      ],
      recipientCount: 1,
      sentBy: 'Jaya Raman',
      sentAt: daysAgo(6),
    },
    {
      subject: 'Please complete your intake forms',
      message: "We noticed your intake packet hasn't been started yet. Please complete it as soon as possible so we can continue your pre-screening.",
      channel: 'both',
      filterTrialId: null,
      filterOverallStatus: null,
      filterFormStatus: 'sent',
      recipients: [
        { patientId: 'RD-0003', patientName: heroName('RD-0003'), deliveryStatus: 'delivered' },
        // A 'both'-channel send only fails when a patient has NEITHER phone
        // nor email (simulateBroadcastDelivery), and RD-0005 has both --
        // 'delivered' is what the simulator would actually produce here.
        { patientId: 'RD-0005', patientName: heroName('RD-0005'), deliveryStatus: 'delivered' },
      ],
      recipientCount: 2,
      sentBy: 'Sanjay Patil',
      sentAt: daysAgo(4),
    },
    {
      message: 'This is a routine check-in from the study team — reply if you have questions about your upcoming visit.',
      channel: 'sms',
      filterTrialId: null,
      filterOverallStatus: null,
      filterFormStatus: null,
      recipients: [
        { patientId: 'RD-0001', patientName: heroName('RD-0001'), deliveryStatus: 'delivered' },
        { patientId: 'RD-0002', patientName: heroName('RD-0002'), deliveryStatus: 'delivered' },
        { patientId: 'RD-0007', patientName: FILLER_PROFILES[0].name, deliveryStatus: 'failed' },
      ],
      recipientCount: 3,
      sentBy: 'Jaya Raman',
      sentAt: daysAgo(1),
    },
  ])

  // Reviews: Pre-Screening Experience Survey responses tied to the completed
  // form submissions for RD-0001, RD-0002, and RD-0004.
  const [rd0001Submission] = await db.select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0001'), eq(formSubmissions.status, 'completed')))
  const [rd0002Submission] = await db.select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0002'), eq(formSubmissions.status, 'completed')))
  const [rd0004Submission] = await db.select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0004'), eq(formSubmissions.status, 'completed')))

  await db.insert(reviews).values([
    {
      patientId: 'RD-0001',
      formSubmissionId: rd0001Submission.id,
      status: 'completed',
      sentAt: daysAgo(27),
      respondedAt: daysAgo(25),
      ratingOverall: 5,
      ratingFormsClarity: 5,
      ratingCommunication: 4,
      comments: 'The intake process was clear and the coordinator was very responsive.',
      sentBy: 'Jaya Raman',
    },
    {
      patientId: 'RD-0002',
      formSubmissionId: rd0002Submission.id,
      status: 'sent',
      sentAt: daysAgo(14),
      sentBy: 'Jaya Raman',
    },
    {
      patientId: 'RD-0004',
      formSubmissionId: rd0004Submission.id,
      status: 'completed',
      sentAt: daysAgo(8),
      respondedAt: daysAgo(7),
      ratingOverall: 3,
      ratingFormsClarity: 3,
      ratingCommunication: 4,
      comments: 'Forms were a bit long but staff followed up quickly.',
      sentBy: 'Jaya Raman',
    },
  ])

  // SECURITY/COMPLIANCE: draft placeholder text, not reviewed legal
  // language -- see the isDraft column comment in schema.ts. Every patient
  // must accept both before reaching (authenticated) portal pages; see
  // hasAcceptedCurrentPolicies() and the (authenticated) layout's gate.
  await db.insert(policyDocuments).values([
    {
      type: 'npp',
      version: 1,
      title: 'Privacy notice',
      bodyMarkdown: '[DRAFT -- NOT REVIEWED BY LEGAL COUNSEL. Replace before any real patient relies on this.]\n\nThis notice describes how your health information may be used and shared, and how you can access it. We keep your health records confidential and use them only for your care, billing and as required by law. You have the right to see and get a copy of your records, to ask for corrections, and to withdraw consent for optional uses.',
      isDraft: true,
      effectiveDate: todayIsoIn(),
    },
    {
      type: 'tos',
      version: 1,
      title: 'Terms of use',
      bodyMarkdown: '[DRAFT -- NOT REVIEWED BY LEGAL COUNSEL. Replace before any real patient relies on this.]\n\nThis portal is not monitored continuously -- in a medical emergency, call 112 or go to the nearest emergency department. Information on this portal is not medical advice. Keep your login details confidential. Messages are usually answered within 1-2 working days. We may suspend portal access at our discretion.',
      isDraft: true,
      effectiveDate: todayIsoIn(),
    },
  ])

  // Wave D: the day-to-day hospital demo, relative to today (IST).
  const summary = await seedIndiaOperations({
    refs,
    patientIds: fillerIds,
    heroIds,
    sessions: {
      admin: sessionFor('admin'), frontdesk: sessionFor('frontdesk'), billing: sessionFor('billing'), labs: sessionFor('labs'),
      pathologist: sessionFor('pathologist'), collector: sessionFor('collector'), coder: sessionFor('coder'), pharmacy: sessionFor('pharmacy'),
      crc: sessionFor('crc'), pi: sessionFor('pi'), rcm: sessionFor('rcm'),
    },
  })
  console.log(`Seeded the hospital day: ${summary.encounters} visits, ${summary.admissions} admissions, ${summary.labOrders} lab orders, ${summary.invoices} invoices.`)
  console.log(`Seeded the insurance desk: ${summary.policies} policies, ${summary.preauths} pre-authorisations, ${summary.claims} claims.`)
  // end Wave D
}

if (require.main === module) {
  seed().then(
    () => { console.log('Seed complete'); process.exit(0) },
    (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) },
  )
}
