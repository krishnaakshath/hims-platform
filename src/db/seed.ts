import { sql, eq, and } from 'drizzle-orm'
import { getDb } from './client'
import { encryptSensitive } from '../lib/crypto'
import { hashPassword } from '../lib/password'
import {
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
  appointments,
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

const MDD_TRIAL = {
  id: 'nct06911112',
  name: 'Adjunctive Treatment in Major Depressive Disorder',
  nctNumber: 'NCT06911112',
  condition: 'Major Depressive Disorder',
  site: 'Redlands',
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
  site: 'Redlands',
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

// Independent provider roster — see the Design Decision section in this
// phase's plan for why this is not backfilled from patients.currentProvider.
// colorTag cycles through the design system's grayscale chart tokens so the
// calendar can color-code providers without ever using a hardcoded color.
const PROVIDER_ROSTER = [
  { name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Psychiatry', colorTag: 'chart-1' },
  { name: 'Dr. Elena Bosch', credentials: 'MD', specialty: 'Psychiatry', colorTag: 'chart-2' },
  { name: 'Priya Sundaram', credentials: 'PMHNP', specialty: 'Psychiatric Nurse Practitioner', colorTag: 'chart-3' },
  { name: 'Dr. Michael Farr', credentials: 'DO', specialty: 'Psychiatry', colorTag: 'chart-4' },
  { name: 'Dana Whitfield', credentials: 'PMHNP', specialty: 'Psychiatric Nurse Practitioner', colorTag: 'chart-5' },
]

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

type HeroPatient = {
  id: string; trialId: string; overallStatus: 'green' | 'yellow' | 'red'
  name: string; dob: string
  city: string; zip: string; phone: string; email: string
  provider: string; ratingScale: { name: string; score: number; date: string }
  diagnosisCode: { code: string; description: string }
  activeMed: { name: string; medicationClass: string; dose: string; startDate: string }
  criteria: { key: string; text: string; verdict: 'green' | 'yellow' | 'red'; quote: string; sourceDoc: string; sourceDate: string }[]
}

const HERO_PATIENTS: HeroPatient[] = [
  {
    id: 'RD-0001', trialId: 'nct06911112', overallStatus: 'green',
    name: 'Maria Alvarez', dob: '1985-03-12',
    city: 'Redlands', zip: '92373', phone: '909-555-0142', email: 'maria.alvarez.demo@example.com',
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
    id: 'RD-0002', trialId: 'nct06911112', overallStatus: 'red',
    name: 'James Thornton', dob: '1990-11-02',
    city: 'Highland', zip: '92346', phone: '909-555-0198', email: 'jthornton.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 9, date: '2026-08-20' },
    diagnosisCode: { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    activeMed: { name: 'Bupropion', medicationClass: 'NDRI (excluded class)', dose: '150mg daily', startDate: '2026-08-01' },
    criteria: [
      { key: 'diagnosis', text: 'Confirmed MDD diagnosis (F32.x/F33.x)', verdict: 'green', quote: 'Dx: F32.1 Major depressive disorder, single episode, moderate', sourceDoc: 'Tebra Condition list', sourceDate: '2026-08-01' },
      { key: 'excluded-medication', text: 'Not currently on an excluded medication class', verdict: 'red', quote: 'Bupropion 150mg daily, start 2026-08-01 — protocol excludes NDRI class', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-08-01' },
    ],
  },
  {
    id: 'RD-0003', trialId: 'nct06911112', overallStatus: 'yellow',
    name: 'Linda Cho', dob: '1978-06-30',
    city: 'Yucaipa', zip: '92399', phone: '909-555-0177', email: 'lcho.demo@example.com',
    provider: 'Unmatched', ratingScale: { name: 'PHQ-9', score: 15, date: '2026-09-05' },
    diagnosisCode: { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    activeMed: { name: 'Unknown', medicationClass: 'Unknown', dose: 'Unknown', startDate: '2026-01-01' },
    criteria: [
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'yellow', quote: 'No matching Tebra chart yet — identity match pending', sourceDoc: 'N/A', sourceDate: '2026-09-05' },
    ],
  },
  {
    id: 'RD-0004', trialId: 'nct-adhd-demo-01', overallStatus: 'green',
    name: 'Priya Natarajan', dob: '1994-02-18',
    city: 'Redlands', zip: '92374', phone: '909-555-0133', email: 'pnatarajan.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'ASRS-v1.1', score: 21, date: '2026-09-02' },
    diagnosisCode: { code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' },
    activeMed: { name: 'None', medicationClass: 'None', dose: 'N/A', startDate: '2026-01-01' },
    criteria: [
      { key: 'diagnosis', text: 'Confirmed ADHD diagnosis (F90.x)', verdict: 'green', quote: 'Dx: F90.2 Attention-deficit hyperactivity disorder, combined type', sourceDoc: 'Tebra Condition list', sourceDate: '2025-11-01' },
      { key: 'stimulant-washout', text: 'No stimulant medication within the last 14 days', verdict: 'green', quote: 'No active or recent stimulant prescriptions on file', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-09-02' },
    ],
  },
  {
    id: 'RD-0005', trialId: 'nct-adhd-demo-01', overallStatus: 'red',
    name: 'Marcus Webb', dob: '1988-09-09',
    city: 'Loma Linda', zip: '92354', phone: '909-555-0161', email: 'mwebb.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'ASRS-v1.1', score: 19, date: '2026-08-28' },
    diagnosisCode: { code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' },
    activeMed: { name: 'Lisdexamfetamine', medicationClass: 'Stimulant', dose: '30mg daily', startDate: '2026-09-01' },
    criteria: [
      { key: 'stimulant-washout', text: 'No stimulant medication within the last 14 days', verdict: 'red', quote: 'Lisdexamfetamine 30mg daily, active as of 2026-09-01', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-09-01' },
    ],
  },
  {
    id: 'RD-0006', trialId: 'nct06911112', overallStatus: 'yellow',
    name: 'Kathryn Voss', dob: '1982-12-05',
    city: 'Redlands', zip: '92373', phone: '909-555-0188', email: 'kvoss.old@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 16, date: '2026-08-15' },
    diagnosisCode: { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
    activeMed: { name: 'Venlafaxine', medicationClass: 'SSRI/SNRI antidepressant', dose: '75mg daily', startDate: '2026-08-10' },
    criteria: [
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'yellow', quote: 'Venlafaxine start date 2026-08-10 is only 5 weeks before referral — needs verification against the 8-week rule', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-08-10' },
    ],
  },
]

// A larger, more varied roster than a handful of near-identical demo rows --
// meant to read like an actual clinic's patient panel (mixed ages, cities,
// diagnoses, referral sources), not just enough rows to exercise the UI.
// Criterion keys among HERO_PATIENTS' hand-authored demo criteria that are
// actually exclusion rules -- everything else defaults to inclusion. Only
// matters for the initial seed's display; the real evaluator (lib/eligibility.ts)
// tags every criterion it generates directly and supersedes these on the
// first Refresh/Run Classification.
const EXCLUSION_CRITERION_KEYS = new Set(['excluded-medication', 'stimulant-washout'])

const FILLER_NAMES = [
  'Robert Nguyen', 'Angela Ferraro', 'Devon Okafor', 'Sana Patel', 'Wesley Turner', 'Isabel Marquez',
  'Owen Fitzgerald', 'Grace Kim', 'Tobias Reyes', 'Nadia Suleiman', 'Colin Brantley', 'Fatima Rashid',
  'Marcus Bellweather', 'Priya Chandrasekaran', 'Diego Salgado', 'Yasmin Haddad', 'Trevor Osei', 'Lena Kowalski',
  'Anthony Delgado', 'Rina Fujimoto', 'Samuel Okonkwo', 'Chloe Bergstrom', 'Amir Farouk', 'Danielle Whitfield',
  'Hassan Malik', 'Sophia Papadakis', 'Elijah Cross', 'Mei Lin Tan', 'Gabriel Ontiveros', 'Renee Castellano',
  'Kwame Asante', 'Ingrid Solheim', 'Julian Restrepo', 'Aaliyah Jefferson', 'Noah Feldman', 'Camille Dubois',
  'Tariq Abbasi', 'Whitney Sorensen', 'Mateo Villareal', 'Simone Achebe', 'Declan O’Farrell', 'Priyanka Deshmukh',
  'Zachary Huang', 'Beatriz Nascimento',
]

const CITY_POOL = [
  { city: 'Redlands', zip: '92373' }, { city: 'Redlands', zip: '92374' }, { city: 'Highland', zip: '92346' },
  { city: 'Yucaipa', zip: '92399' }, { city: 'Loma Linda', zip: '92354' }, { city: 'San Bernardino', zip: '92404' },
  { city: 'Riverside', zip: '92501' }, { city: 'Colton', zip: '92324' }, { city: 'Rialto', zip: '92376' },
  { city: 'Beaumont', zip: '92223' }, { city: 'Banning', zip: '92220' }, { city: 'Calimesa', zip: '92320' },
]

const REFERRAL_TYPES = ['Self-referral', 'Provider referral', 'Community outreach', 'Insurance panel referral']
const AVAILABILITY_OPTIONS = ['Weekday mornings', 'Weekday afternoons', 'Evenings only', 'Flexible', 'Weekends only']

// A broader diagnosis/medication pool than just the two active trials'
// conditions -- most of a real clinic's panel isn't enrolled in either
// study, which is exactly why most of these patients get no trial
// screening row at all (see seedFillerPatients below).
const GENERAL_DIAGNOSES = [
  { code: 'F41.1', description: 'Generalized anxiety disorder' },
  { code: 'F43.10', description: 'Post-traumatic stress disorder' },
  { code: 'F31.81', description: 'Bipolar II disorder' },
  { code: 'F41.0', description: 'Panic disorder' },
  { code: 'F42.2', description: 'Mixed obsessional thoughts and acts' },
  { code: 'G47.00', description: 'Insomnia, unspecified' },
  { code: 'F10.20', description: 'Alcohol use disorder, moderate' },
  { code: 'F60.3', description: 'Borderline personality disorder' },
]

const GENERAL_MEDICATIONS = [
  { name: 'Fluoxetine', medicationClass: 'SSRI/SNRI antidepressant', dose: '20mg daily' },
  { name: 'Escitalopram', medicationClass: 'SSRI/SNRI antidepressant', dose: '10mg daily' },
  { name: 'Duloxetine', medicationClass: 'SSRI/SNRI antidepressant', dose: '60mg daily' },
  { name: 'Lamotrigine', medicationClass: 'Mood stabilizer', dose: '100mg daily' },
  { name: 'Aripiprazole', medicationClass: 'Atypical antipsychotic', dose: '5mg daily' },
  { name: 'Buspirone', medicationClass: 'Anxiolytic', dose: '15mg twice daily' },
  { name: 'Hydroxyzine', medicationClass: 'Antihistamine anxiolytic', dose: '25mg as needed' },
  { name: 'Vyvanse', medicationClass: 'Stimulant', dose: '40mg daily' },
]

async function seedFillerPatients() {
  const db = getDb()
  for (let i = 0; i < FILLER_NAMES.length; i++) {
    const id = `RD-${String(7 + i).padStart(4, '0')}`

    // Safe to re-run against an already-populated shared dev DB: skip any id
    // that already exists (e.g. a real patient a user created by hand
    // through the app that happens to land on the same anon-id slot) rather
    // than failing or duplicating.
    const [existing] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))
    if (existing) continue

    const [first, last] = FILLER_NAMES[i].split(' ')
    const location = CITY_POOL[i % CITY_POOL.length]
    const birthYear = 1955 + (i * 7) % 50 // spreads ages roughly 18-70
    const birthMonth = String((i % 12) + 1).padStart(2, '0')
    const birthDay = String(((i * 3) % 27) + 1).padStart(2, '0')
    const inTrial = i % 3 !== 2 // ~2/3 of the panel is enrolled in one of the two active trials; the rest is general-population patients not part of either study
    const trial = i % 2 === 0 ? MDD_TRIAL : ADHD_TRIAL
    const status: 'green' | 'yellow' | 'red' = ['green', 'green', 'yellow', 'red'][i % 4] as 'green' | 'yellow' | 'red'

    await db.insert(patients).values({
      id,
      name: FILLER_NAMES[i],
      dob: `${birthYear}-${birthMonth}-${birthDay}`,
      city: location.city,
      zip: location.zip,
      // RD-0007 (i === 0) is deliberately left with no phone number at all --
      // it's the one seeded broadcast recipient (Phase 5) whose SMS delivery
      // is meant to genuinely fail per simulateBroadcastDelivery's own logic,
      // rather than a hand-authored 'failed' status the simulator could
      // never actually produce for a patient with real contact info.
      phone: i === 0 ? null : `909-555-0${String(300 + i).padStart(3, '0')}`,
      email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}.demo@example.com`,
      currentProvider: PROVIDER_ROSTER[i % PROVIDER_ROSTER.length].name,
      ratingScales: inTrial ? [{ name: trial.ratingScales[0].name, score: 8 + (i % 16), date: '2026-09-01' }] : [],
      referralType: REFERRAL_TYPES[i % REFERRAL_TYPES.length],
      availability: AVAILABILITY_OPTIONS[i % AVAILABILITY_OPTIONS.length],
      commConsentSigned: i % 4 !== 3,
      commConsentPref: ['Phone', 'Email', 'Text'][i % 3],
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
      // General-population patient, not part of either active study --
      // still a real chart with its own diagnosis, so the panel doesn't
      // read as "trial candidates only."
      const dx = GENERAL_DIAGNOSES[i % GENERAL_DIAGNOSES.length]
      await db.insert(diagnoses).values({ patientId: id, code: dx.code, description: dx.description, date: '2026-07-15' })
    }

    // Roughly half the panel has an active medication on file, drawn from a
    // pool wide enough that the Medications view doesn't look like everyone
    // is on the same drug.
    if (i % 2 === 0) {
      const med = GENERAL_MEDICATIONS[i % GENERAL_MEDICATIONS.length]
      await db.insert(medicationEpisodes).values({ patientId: id, name: med.name, medicationClass: med.medicationClass, dose: med.dose, startDate: '2026-06-01', status: 'active' })
    }

    // A handful of allergies, since real charts aren't uniformly blank here.
    if (i % 6 === 0) {
      const allergy = [{ allergen: 'Penicillin', reaction: 'Rash' }, { allergen: 'Sulfa drugs', reaction: 'Hives' }, { allergen: 'Latex', reaction: 'Contact dermatitis' }, { allergen: 'Shellfish', reaction: 'Anaphylaxis' }][i % 4]
      await db.insert(allergies).values({ patientId: id, allergen: allergy.allergen, reaction: allergy.reaction, severity: (['mild', 'moderate', 'severe'] as const)[i % 3] })
    }
  }
}

async function seedDocumentsAndFaxes() {
  const db = getDb()

  // Documents: metadata-only rows demonstrating the New/Processed status split,
  // a mix of labels, and both patient-linked and unlinked documents.
  await db.insert(documents).values([
    { name: 'Drivers License - Front.jpg', documentDate: '2026-08-10', status: 'processed', receivedFrom: 'Patient Portal Upload', documentType: 'drivers_license', patientId: 'RD-0001', fileType: 'JPG' },
    { name: 'Signed Consent Form.pdf', documentDate: '2026-08-12', status: 'processed', receivedFrom: 'Jamie Ruiz (CRC)', documentType: 'legal_document', patientId: 'RD-0001', fileType: 'PDF' },
    { name: 'Outside Lab Results.pdf', documentDate: '2026-08-14', status: 'new', receivedFrom: 'Fax', documentType: 'other', patientId: 'RD-0002', fileType: 'PDF' },
    { name: 'Referral Letter.pdf', documentDate: '2026-08-15', status: 'new', receivedFrom: 'Referring Provider Office', documentType: 'other', patientId: 'RD-0003', fileType: 'PDF' },
    { name: 'State ID Card.png', documentDate: '2026-08-16', status: 'processed', receivedFrom: 'Patient Portal Upload', documentType: 'drivers_license', patientId: 'RD-0002', fileType: 'PNG' },
    { name: 'Power of Attorney.pdf', documentDate: '2026-08-18', status: 'new', receivedFrom: 'Mail', documentType: 'legal_document', patientId: 'RD-0004', fileType: 'PDF' },
    { name: 'Prior Medication List.pdf', documentDate: '2026-08-19', status: 'processed', receivedFrom: 'Priya Natarajan (CRC)', documentType: 'other', patientId: 'RD-0004', fileType: 'PDF' },
    { name: 'Insurance Card - Back.jpg', documentDate: '2026-08-20', status: 'new', receivedFrom: 'Patient Portal Upload', documentType: 'other', patientId: 'RD-0005', fileType: 'JPG' },
    { name: 'Telehealth Consent.pdf', documentDate: '2026-08-21', status: 'processed', receivedFrom: 'Jamie Ruiz (CRC)', documentType: 'legal_document', patientId: 'RD-0006', fileType: 'PDF' },
    { name: 'Passport Copy.pdf', documentDate: '2026-08-22', status: 'new', receivedFrom: 'Fax', documentType: 'drivers_license', patientId: 'RD-0003', fileType: 'PDF' },
  ])

  // Faxes: a mix of delivered/failed SIMULATED statuses across several patients
  // and senders, so Fax History is demonstrable without ever implying a real
  // fax was sent (see the disclaimer requirement on the Fax History tab).
  await db.insert(faxes).values([
    { faxDate: new Date('2026-08-10T09:15:00'), subject: 'Lab Results - CBC Panel', documentsIncluded: 'CBC Panel Results.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2201', patientId: 'RD-0001' },
    { faxDate: new Date('2026-08-11T14:32:00'), subject: 'Signed Consent Form', documentsIncluded: 'General Research Consent.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2202', patientId: 'RD-0002' },
    { faxDate: new Date('2026-08-12T11:05:00'), subject: 'Referral Records Request', documentsIncluded: 'Records Request Form.pdf', deliveryStatus: 'failed', sender: 'Priya Natarajan (CRC)', sentToFaxNumber: '(555) 010-2203', patientId: 'RD-0003' },
    { faxDate: new Date('2026-08-13T08:47:00'), subject: 'Prior Authorization', documentsIncluded: 'Prior Auth Request.pdf', deliveryStatus: 'delivered', sender: 'Sam Patel (Admin)', sentToFaxNumber: '(555) 010-2204', patientId: 'RD-0004' },
    { faxDate: new Date('2026-08-14T16:20:00'), subject: 'Medication History', documentsIncluded: 'Medication History.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2205', patientId: 'RD-0005' },
    { faxDate: new Date('2026-08-15T10:00:00'), subject: 'Screening Questionnaire Results', documentsIncluded: 'PHQ-9 Results.pdf, ASRS Results.pdf', deliveryStatus: 'failed', sender: 'Priya Natarajan (CRC)', sentToFaxNumber: '(555) 010-2206', patientId: 'RD-0006' },
    { faxDate: new Date('2026-08-16T13:40:00'), subject: 'Telehealth Consent Confirmation', documentsIncluded: 'Telehealth Consent.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2207', patientId: 'RD-0006' },
    { faxDate: new Date('2026-08-17T09:55:00'), subject: 'Insurance Verification', documentsIncluded: 'Insurance Card Copy.pdf', deliveryStatus: 'delivered', sender: 'Sam Patel (Admin)', sentToFaxNumber: '(555) 010-2208', patientId: 'RD-0002' },
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
        onsetDate: '2026-08-15', reportedDate: '2026-08-16', reportedByName: 'Jamie Ruiz',
      },
      {
        trialId: 'nct06911112', patientId: 'RD-0002',
        description: 'Emergency room visit for chest pain, ruled cardiac-unrelated; admitted overnight for observation.',
        severity: 'severe', serious: true, causality: 'unlikely', outcome: 'resolved',
        onsetDate: '2026-09-20', reportedDate: '2026-09-20', reportedByName: 'Jamie Ruiz',
        sponsorNotifiedAt: new Date('2026-09-20T18:00:00'), irbNotifiedAt: new Date('2026-09-22T09:00:00'),
      },
    ])
  }

  const [{ count: daCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(drugAccountabilityEntries)
  if (daCount === 0) {
    await db.insert(drugAccountabilityEntries).values([
      { trialId: 'nct06911112', patientId: null, lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'received', quantity: 500, performedByName: 'Jamie Ruiz', date: '2026-07-01', notes: 'Initial shipment from sponsor' },
      { trialId: 'nct06911112', patientId: 'RD-0001', lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'dispensed', quantity: 30, performedByName: 'Jamie Ruiz', date: '2026-08-01' },
      { trialId: 'nct06911112', patientId: 'RD-0002', lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'dispensed', quantity: 30, performedByName: 'Jamie Ruiz', date: '2026-08-03' },
      { trialId: 'nct06911112', patientId: 'RD-0001', lotNumber: 'LOT-SER-2026-04', expirationDate: '2027-04-30', action: 'returned', quantity: 6, performedByName: 'Jamie Ruiz', date: '2026-08-29', notes: 'Participant missed 2 doses' },
    ])
  }

  const [{ count: regCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(regulatoryDocuments)
  if (regCount === 0) {
    await db.insert(regulatoryDocuments).values([
      { trialId: 'nct06911112', documentType: 'form_1572', title: 'Statement of Investigator (Form FDA 1572)', effectiveDate: '2026-06-01', uploadedByName: 'Jamie Ruiz' },
      { trialId: 'nct06911112', documentType: 'delegation_log', title: 'Site Delegation of Authority Log', version: 'v3', effectiveDate: '2026-07-15', uploadedByName: 'Jamie Ruiz' },
      { trialId: 'nct06911112', documentType: 'irb_approval', title: 'IRB Continuing Review Approval', effectiveDate: '2025-10-01', expirationDate: '2026-10-01', uploadedByName: 'Jamie Ruiz' },
      { trialId: 'nct06911112', documentType: 'protocol', title: 'Study Protocol', version: 'Amendment 2', effectiveDate: '2026-03-01', uploadedByName: 'Jamie Ruiz' },
    ])
  }
}

// Payer reference directory -- 14 major US health plans covering the
// commercial/medicare/medicaid/tricare payerType split. This used to exist
// only as live database state from a since-deleted scratch migration
// script, which meant a fresh/reset DB had an empty payer dropdown
// everywhere and tests/lib/queries/payers.test.ts failed outright. Names,
// payerIds, and types below match what that script actually inserted
// (reconstructed from the live shared dev DB and the payer directory test's
// assertions), so re-seeding a fresh database reproduces the same directory
// the rest of this branch was built and reviewed against.
const PAYERS_SEED: { name: string; payerId: string; payerType: 'commercial' | 'medicare' | 'medicaid' | 'tricare' | 'other' }[] = [
  { name: 'Aetna', payerId: '60054', payerType: 'commercial' },
  { name: 'UnitedHealthcare', payerId: '87726', payerType: 'commercial' },
  { name: 'Cigna', payerId: '62308', payerType: 'commercial' },
  { name: 'Humana', payerId: '61101', payerType: 'commercial' },
  { name: 'Anthem Blue Cross of California', payerId: '47198', payerType: 'commercial' },
  { name: 'Blue Shield of California', payerId: '47163', payerType: 'commercial' },
  { name: 'Kaiser Permanente', payerId: '94134', payerType: 'commercial' },
  { name: 'Molina Healthcare', payerId: '38333', payerType: 'commercial' },
  { name: 'Ambetter (Centene)', payerId: '68069', payerType: 'commercial' },
  { name: 'Oscar Health', payerId: '72187', payerType: 'commercial' },
  { name: 'Health Net', payerId: '95567', payerType: 'commercial' },
  { name: 'Medicare (Noridian, CA)', payerId: '00590', payerType: 'medicare' },
  { name: 'Medi-Cal', payerId: '12X0', payerType: 'medicaid' },
  { name: 'TRICARE', payerId: '99726', payerType: 'tricare' },
]

async function seedPayers() {
  const db = getDb()
  // Idempotent per-row (not just a top-level count guard): insert only the
  // names that aren't already present, so this is also safe to call from
  // the "already seeded" top-up path without duplicating rows if it's ever
  // called more than once or a caller partially seeded the directory by hand.
  const existing = await db.select({ name: payers.name }).from(payers)
  const existingNames = new Set(existing.map((p) => p.name))
  const toInsert = PAYERS_SEED.filter((p) => !existingNames.has(p.name))
  if (toInsert.length > 0) await db.insert(payers).values(toInsert)
}

// Lab test catalog -- standalone reference data (like the payer directory
// above), independent of whether the rest of the DB has been seeded.
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
  // Idempotent per-row by code, same discipline as seedPayers() above --
  // insert only the codes not already present, so this is safe to call
  // unconditionally on every seed() run without duplicating rows.
  const existing = await db.select({ code: labTests.code }).from(labTests)
  const existingCodes = new Set(existing.map((t) => t.code))
  const toInsert = LAB_TESTS_SEED.filter((t) => !existingCodes.has(t.code))
  if (toInsert.length > 0) await db.insert(labTests).values(toInsert)
}

// Best-effort payerId match for a claim's free-text payerName -- mirrors the
// "payerName contains payer.name" rule the original (now-deleted) migration
// script's backfill used: e.g. 'Aetna' and 'Cigna' match exactly, but
// 'Blue Shield' does NOT match the seeded 'Blue Shield of California' (the
// claim's shorter free-text name isn't a superstring of the payer's full
// legal name), and likewise 'United Healthcare' doesn't match
// 'UnitedHealthcare' (no space) and 'Medicare' doesn't match 'Medicare
// (Noridian, CA)'. Those three stay payerId: null, same as the original
// migration's backfill left them -- a real gap, not a bug in the matcher.
function matchPayerId(allPayers: { id: number; name: string }[], payerName: string): number | null {
  return allPayers.find((p) => payerName.toLowerCase().includes(p.name.toLowerCase()))?.id ?? null
}

// Medication catalog seed -- 15 commonly prescribed psychiatric medications
// spanning the drug classes this clinic's patients are typically on (SSRI/
// SNRI/atypical antidepressants, atypical antipsychotics, benzodiazepines,
// stimulants, a mood stabilizer, and Spravato). `name` is the generic/
// clinical name -- matching this app's existing convention elsewhere in
// this file (see medicationEpisodes seeding above, which also uses generic
// names as the primary identifier) and required by this plan's Task 2,
// which asserts against these exact generic-name values. `genericName` is
// left null throughout since `name` already holds the generic name; there's
// no separate brand name to cross-reference here.
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
]

// Starting stock levels keyed by medication name -- a plausible starting
// point, not a clinically precise figure. Controlled substances (the
// benzodiazepines and stimulants) and the in-office-only Esketamine
// (Spravato) get smaller on-hand quantities and tighter reorder thresholds
// than routine oral antidepressants/antipsychotics.
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
}

async function seedMedications() {
  const db = getDb()
  // Idempotent per-row, same convention as seedPayers() above: only insert
  // medications/inventory rows that aren't already present, so this is safe
  // to call unconditionally on every seed() run (including a top-up call
  // against an already-seeded DB) without duplicating catalog rows or
  // violating medicationInventory's one-row-per-medication unique constraint.
  const existingMeds = await db.select({ id: medications.id, name: medications.name }).from(medications)
  const existingNames = new Set(existingMeds.map((m) => m.name))
  const toInsert = MEDICATIONS_SEED.filter((m) => !existingNames.has(m.name))
  if (toInsert.length > 0) await db.insert(medications).values(toInsert)

  // Scoped to the intended 15-drug catalog (MEDICATIONS_SEED), not every row
  // currently in `medications` -- iterating the full table would also grant
  // inventory (and therefore dashboard visibility/dispensability) to any
  // stray row, including leaked test rows from a buggy test helper (see
  // tests/lib/queries/medication-dispenses.test.ts's makeMedWithStock, fixed
  // separately) or a future rename-without-cleanup duplicate.
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

// Staff roster -- deliberately mixes three linkage shapes per spec §1: some
// staff are both a system user AND a clinical provider, some are only one,
// and some (front-desk/facilities roles) are neither. Matched by name
// against the demo `users` rows and `PROVIDER_ROSTER` providers already
// seeded above, rather than hardcoded ids, since insertion order can vary.
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
  { name: 'Dr. Rajiv Kunam', linkUserLocal: 'pi', linkProviderName: 'Dr. Rajiv Kunam', department: 'Clinical', title: 'Psychiatrist', employmentStatus: 'active', hireDate: '2021-03-01', terminationDate: null },
  { name: 'Dr. Elena Bosch', linkUserLocal: null, linkProviderName: 'Dr. Elena Bosch', department: 'Clinical', title: 'Psychiatrist', employmentStatus: 'active', hireDate: '2022-06-15', terminationDate: null },
  { name: 'Priya Sundaram', linkUserLocal: null, linkProviderName: 'Priya Sundaram', department: 'Clinical', title: 'Psychiatric Nurse Practitioner', employmentStatus: 'active', hireDate: '2023-01-10', terminationDate: null },
  { name: 'Jamie Ruiz', linkUserLocal: 'crc', linkProviderName: null, department: 'Research', title: 'Clinical Research Coordinator', employmentStatus: 'active', hireDate: '2022-09-01', terminationDate: null },
  { name: 'Sam Patel', linkUserLocal: 'admin', linkProviderName: null, department: 'Administration', title: 'Practice Administrator', employmentStatus: 'active', hireDate: '2020-11-01', terminationDate: null },
  { name: 'Taylor Nguyen', linkUserLocal: 'frontdesk', linkProviderName: null, department: 'Front Desk', title: 'Front Desk Coordinator', employmentStatus: 'active', hireDate: '2023-04-20', terminationDate: null },
  { name: 'Morgan Reyes', linkUserLocal: null, linkProviderName: null, department: 'Front Desk', title: 'Receptionist', employmentStatus: 'active', hireDate: '2024-02-01', terminationDate: null },
  { name: 'Casey Boone', linkUserLocal: null, linkProviderName: null, department: 'Facilities', title: 'Housekeeping', employmentStatus: 'on_leave', hireDate: '2021-08-15', terminationDate: null },
  { name: 'Riley Foster', linkUserLocal: null, linkProviderName: null, department: 'Administration', title: 'Billing Specialist', employmentStatus: 'terminated', hireDate: '2019-05-01', terminationDate: '2026-06-30' },
]

// Credential dates are computed relative to seed time, not hardcoded, so the
// 60-day warning window and the "already expired" state always have real
// demo data to show regardless of when this seed script actually runs.
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

const STAFF_CREDENTIALS_SEED: { staffName: string; credentialType: string; credentialNumber: string | null; expiresOn: string | null }[] = [
  { staffName: 'Dr. Rajiv Kunam', credentialType: 'State Medical License', credentialNumber: 'CA-MD-48213', expiresOn: daysFromNow(400) },
  { staffName: 'Dr. Rajiv Kunam', credentialType: 'DEA Registration', credentialNumber: 'BK1234563', expiresOn: daysFromNow(30) }, // inside the 60-day warning window
  { staffName: 'Dr. Elena Bosch', credentialType: 'State Medical License', credentialNumber: 'CA-MD-51902', expiresOn: daysFromNow(-15) }, // already expired
  { staffName: 'Dr. Elena Bosch', credentialType: 'Board Certification', credentialNumber: 'ABPN-88213', expiresOn: daysFromNow(500) },
  { staffName: 'Priya Sundaram', credentialType: 'State NP License', credentialNumber: 'CA-NP-33012', expiresOn: daysFromNow(200) },
  { staffName: 'Priya Sundaram', credentialType: 'DEA Registration', credentialNumber: 'MS9988771', expiresOn: daysFromNow(55) }, // inside the 60-day warning window
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

async function seedBilling() {
  const db = getDb()
  const allPayers = await db.select({ id: payers.id, name: payers.name }).from(payers)

  const chargeRows = await db.insert(charges).values([
    // Workflow-state charges (not yet submitted -- excluded from A/R).
    {
      patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-14', status: 'draft',
      diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
      procedureCodes: [{ code: '90837', description: 'Psychotherapy, 60 minutes', units: 1, chargeCents: 15000 }],
      amountCents: 15000,
    },
    {
      patientId: 'RD-0002', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-12', status: 'pending_approval',
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 20000 }],
      amountCents: 20000,
    },
    {
      patientId: 'RD-0003', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-10', status: 'pending_approval',
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99213', description: 'Office visit, established patient, low complexity', units: 1, chargeCents: 12000 }],
      amountCents: 12000,
    },
    {
      patientId: 'RD-0004', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-08', status: 'approved',
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 18000 }],
      amountCents: 18000,
    },
    {
      patientId: 'RD-0005', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-06', status: 'approved',
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99215', description: 'Office visit, established patient, high complexity', units: 1, chargeCents: 22000 }],
      amountCents: 22000,
    },
    // Submitted charges -- these are what the A/R Dashboard and Patient
    // Collections aggregate over. One per aging bucket, plus a second
    // 0-30 charge (RD-0005) used to demonstrate an overpayment/unapplied
    // amount via a mock payment in the block below.
    {
      patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-05', status: 'submitted', // 12 days -> 0-30
      diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
      procedureCodes: [{ code: '90837', description: 'Psychotherapy, 60 minutes', units: 1, chargeCents: 15000 }],
      amountCents: 15000,
    },
    {
      patientId: 'RD-0002', providerName: 'Dr. R. Kunam', dateOfService: '2026-08-10', status: 'submitted', // 38 days -> 31-60
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 20000 }],
      amountCents: 20000,
    },
    {
      patientId: 'RD-0003', providerName: 'Dr. R. Kunam', dateOfService: '2026-07-05', status: 'submitted', // 74 days -> 61-90
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99213', description: 'Office visit, established patient, low complexity', units: 1, chargeCents: 12500 }],
      amountCents: 12500,
    },
    {
      patientId: 'RD-0006', providerName: 'Dr. R. Kunam', dateOfService: '2026-05-25', status: 'submitted', // 115 days -> 91-120
      diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
      procedureCodes: [{ code: '90837', description: 'Psychotherapy, 60 minutes', units: 2, chargeCents: 30000 }],
      amountCents: 30000,
    },
    {
      patientId: 'RD-0004', providerName: 'Dr. R. Kunam', dateOfService: '2026-03-01', status: 'submitted', // 200 days -> 121+
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 9000 }],
      amountCents: 9000,
    },
    {
      patientId: 'RD-0005', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-01', status: 'submitted', // 16 days -> 0-30
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99215', description: 'Office visit, established patient, high complexity', units: 1, chargeCents: 17500 }],
      amountCents: 17500,
    },
  ]).returning()

  const byDos = (dos: string) => chargeRows.find((c) => c.dateOfService === dos)!
  const chargeRd1Submitted = byDos('2026-09-05')
  const chargeRd2Submitted = byDos('2026-08-10')
  const chargeRd3Submitted = byDos('2026-07-05')
  const chargeRd6Submitted = byDos('2026-05-25')
  const chargeRd4Submitted = byDos('2026-03-01')
  const chargeRd5Submitted = byDos('2026-09-01')

  await db.insert(insuranceClaims).values([
    { chargeId: chargeRd1Submitted.id, patientId: 'RD-0001', payerName: 'Blue Shield', payerId: matchPayerId(allPayers, 'Blue Shield'), billedAmountCents: 15000, paidAmountCents: 15000, status: 'paid', submittedDate: '2026-09-05' },
    { chargeId: chargeRd2Submitted.id, patientId: 'RD-0002', payerName: 'Aetna', payerId: matchPayerId(allPayers, 'Aetna'), billedAmountCents: 20000, paidAmountCents: null, status: 'waiting_adjudication', submittedDate: '2026-08-10' },
    { chargeId: chargeRd3Submitted.id, patientId: 'RD-0003', payerName: 'Cigna', payerId: matchPayerId(allPayers, 'Cigna'), billedAmountCents: 12500, paidAmountCents: 0, status: 'denied', submittedDate: '2026-07-05', notes: 'Missing prior authorization on file.' },
    { chargeId: chargeRd6Submitted.id, patientId: 'RD-0006', payerName: 'United Healthcare', payerId: matchPayerId(allPayers, 'United Healthcare'), billedAmountCents: 30000, paidAmountCents: null, status: 'needs_investigation', submittedDate: '2026-05-25', notes: 'Payer requesting additional medical records.' },
    { chargeId: chargeRd4Submitted.id, patientId: 'RD-0004', payerName: 'Medicare', payerId: matchPayerId(allPayers, 'Medicare'), billedAmountCents: 9000, paidAmountCents: 0, status: 'rejected', submittedDate: '2026-03-01', notes: 'Invalid procedure code modifier.' },
  ])

  // Two mock payments: one Luhn-valid ("success"), one Luhn-invalid
  // ("failed"). The success payment (RD-0005, $200.00) exceeds its
  // charge's $175.00 balance on purpose, so Patient Collections has a
  // non-zero "unapplied" amount to demonstrate ($25.00).
  await db.insert(mockPayments).values([
    { patientId: 'RD-0005', chargeId: chargeRd5Submitted.id, amountCents: 20000, cardLast4: '4242', expMonth: 12, expYear: 2027, result: 'success', createdAt: new Date('2026-09-02') },
    { patientId: 'RD-0003', chargeId: chargeRd3Submitted.id, amountCents: 12500, cardLast4: '4444', expMonth: 1, expYear: 2028, result: 'failed', createdAt: new Date('2026-07-10') },
  ])

  await db.insert(patientStatements).values([
    { patientId: 'RD-0002', amountCents: 20000, deliveryMethod: 'email', type: 'reminder', deliveryStatus: 'delivered', sentDate: new Date('2026-08-15') },
    { patientId: 'RD-0003', amountCents: 12500, deliveryMethod: 'paper', type: 'initial', deliveryStatus: 'delivered', sentDate: new Date('2026-07-10') },
    { patientId: 'RD-0006', amountCents: 30000, deliveryMethod: 'sms', type: 'final_notice', deliveryStatus: 'failed', sentDate: new Date('2026-08-25') },
    { patientId: 'RD-0004', amountCents: 9000, deliveryMethod: 'email', type: 'reminder', deliveryStatus: 'delivered', sentDate: new Date('2026-09-01') },
  ])
}

const DEPARTMENT_SEED: { code: string; name: string; kind: 'clinical' | 'diagnostic' | 'support' | 'administrative' }[] = [
  { code: 'GEN_MED', name: 'General Medicine', kind: 'clinical' },
  { code: 'GEN_SURG', name: 'General Surgery', kind: 'clinical' },
  { code: 'PAED', name: 'Paediatrics', kind: 'clinical' },
  { code: 'OBG', name: 'Obstetrics & Gynaecology', kind: 'clinical' },
  { code: 'ORTHO', name: 'Orthopaedics', kind: 'clinical' },
  { code: 'CARDIO', name: 'Cardiology', kind: 'clinical' },
  { code: 'EMERG', name: 'Emergency', kind: 'clinical' },
  { code: 'LAB', name: 'Laboratory', kind: 'diagnostic' },
  { code: 'RADIO', name: 'Radiology', kind: 'diagnostic' },
  { code: 'PHARM', name: 'Pharmacy', kind: 'support' },
  { code: 'ADMIN', name: 'Administration', kind: 'administrative' },
]

async function seedProvidersAndAppointments() {
  const db = getDb()
  await db.insert(departments).values(DEPARTMENT_SEED).onConflictDoNothing()
  const insertedProviders = await db.insert(providers).values(PROVIDER_ROSTER).returning()
  const [kunam, bosch, sundaram, farr, whitfield] = insertedProviders

  // Appointments spread across past (completed/no-show/cancelled), today
  // (2026-09-17), and upcoming dates so Day/Week/Month views and the Home
  // Dashboard's Upcoming Appointments widget all have real demo data.
  await db.insert(appointments).values([
    { patientId: 'RD-0001', providerId: kunam.id, startsAt: new Date('2026-09-10T09:00:00'), endsAt: new Date('2026-09-10T09:30:00'), visitReason: 'Pre-screening follow-up', status: 'completed' },
    { patientId: 'RD-0006', providerId: kunam.id, startsAt: new Date('2026-09-12T14:00:00'), endsAt: new Date('2026-09-12T14:30:00'), visitReason: 'Medication review', status: 'no_show' },
    { patientId: 'RD-0005', providerId: whitfield.id, startsAt: new Date('2026-09-16T11:00:00'), endsAt: new Date('2026-09-16T11:30:00'), visitReason: 'Intake consult', status: 'cancelled' },
    { patientId: 'RD-0002', providerId: bosch.id, startsAt: new Date('2026-09-17T09:00:00'), endsAt: new Date('2026-09-17T09:30:00'), visitReason: 'PHQ-9 rescreen', status: 'scheduled' },
    { patientId: 'RD-0004', providerId: sundaram.id, startsAt: new Date('2026-09-17T10:30:00'), endsAt: new Date('2026-09-17T11:00:00'), visitReason: 'ASRS follow-up', status: 'scheduled' },
    { patientId: 'RD-0003', providerId: farr.id, startsAt: new Date('2026-09-18T13:00:00'), endsAt: new Date('2026-09-18T13:30:00'), visitReason: 'Identity verification appointment', status: 'scheduled' },
    { patientId: 'RD-0007', providerId: kunam.id, startsAt: new Date('2026-09-19T09:00:00'), endsAt: new Date('2026-09-19T09:30:00'), visitReason: 'New patient intake', status: 'scheduled' },
    { patientId: 'RD-0008', providerId: bosch.id, startsAt: new Date('2026-09-22T15:00:00'), endsAt: new Date('2026-09-22T15:30:00'), visitReason: 'Screening visit', status: 'scheduled' },
    { patientId: 'RD-0009', providerId: whitfield.id, startsAt: new Date('2026-09-24T10:00:00'), endsAt: new Date('2026-09-24T10:30:00'), visitReason: 'Consent review', status: 'scheduled' },
    { patientId: 'RD-0010', providerId: sundaram.id, startsAt: new Date('2026-09-25T09:30:00'), endsAt: new Date('2026-09-25T10:00:00'), visitReason: 'Baseline rating scale', status: 'scheduled' },
    { patientId: 'RD-0011', providerId: farr.id, startsAt: new Date('2026-09-29T13:30:00'), endsAt: new Date('2026-09-29T14:00:00'), visitReason: 'Follow-up visit', status: 'scheduled' },
    { patientId: 'RD-0012', providerId: kunam.id, startsAt: new Date('2026-09-30T11:00:00'), endsAt: new Date('2026-09-30T11:30:00'), visitReason: 'Randomization visit', status: 'scheduled' },
  ])

  return insertedProviders
}

// Spreads a few appointments across the expanded filler roster (RD-0020+)
// so the Calendar and the Home dashboard's Upcoming Appointments widget
// reflect the fuller panel too, not just the original 12 demo patients.
// Idempotent: skips any patient that already has an appointment on file.
async function seedAdditionalAppointmentsForExpandedRoster() {
  const db = getDb()
  const rosterProviders = await db.select().from(providers)
  if (rosterProviders.length === 0) return

  const VISIT_REASONS = ['New patient intake', 'Medication review', 'Follow-up visit', 'Screening visit', 'Consent review', 'Baseline rating scale']
  let dayOffset = 3

  for (let i = 12; i < FILLER_NAMES.length; i++) {
    const id = `RD-${String(7 + i).padStart(4, '0')}`
    const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))
    if (!patient) continue // this id was skipped in seedFillerPatients (e.g. a real user-created patient already occupies it)
    if (i % 2 !== 0) continue // spread appointments across roughly half of the new roster, not every patient

    const [existingAppt] = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.patientId, id))
    if (existingAppt) continue

    const provider = rosterProviders[i % rosterProviders.length]
    const startsAt = new Date(`2026-10-${String(1 + (dayOffset % 28)).padStart(2, '0')}T${String(9 + (i % 6)).padStart(2, '0')}:00:00`)
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000)
    dayOffset += 2

    await db.insert(appointments).values({
      patientId: id,
      providerId: provider.id,
      startsAt,
      endsAt,
      visitReason: VISIT_REASONS[i % VISIT_REASONS.length],
      status: 'scheduled',
    })
  }
}

// A handful of inpatient rooms across a few wards, all available -- gives the
// front desk check-in flow real rooms to pick from instead of an always-empty
// list. Distinct room/bed numbers per ward so the "Ward — Room X, Bed Y"
// display in CheckInModal doesn't repeat.
const ROOM_ROSTER = [
  { ward: 'Ward A', roomNumber: '101', bedNumber: 'A' },
  { ward: 'Ward A', roomNumber: '101', bedNumber: 'B' },
  { ward: 'Ward A', roomNumber: '102', bedNumber: 'A' },
  { ward: 'Ward B', roomNumber: '201', bedNumber: 'A' },
  { ward: 'Ward B', roomNumber: '202', bedNumber: 'A' },
  { ward: 'Ward B', roomNumber: '202', bedNumber: 'B' },
  { ward: 'ICU', roomNumber: '301', bedNumber: 'A' },
  { ward: 'ICU', roomNumber: '302', bedNumber: 'A' },
]

async function seedRooms() {
  const db = getDb()
  await db.insert(rooms).values(ROOM_ROSTER.map((r) => ({ ...r, status: 'available' as const })))
}

// SP5: default home-collection windows ('HH:MM' IST). No service-area PINs are seeded:
// they are deployment-specific and set in Settings -> Lab setup. The seed creates no lab
// orders, so there are no seeded orders needing a requisition.
const HOME_COLLECTION_WINDOWS_SEED = [
  { label: 'Early morning', startTime: '07:00', endTime: '09:00', capacity: 10, sortOrder: 1 },
  { label: 'Morning', startTime: '09:00', endTime: '11:00', capacity: 10, sortOrder: 2 },
  { label: 'Late morning', startTime: '11:00', endTime: '13:00', capacity: 8, sortOrder: 3 },
]

async function seedHomeCollectionWindows() {
  await getDb().insert(homeCollectionWindows).values(HOME_COLLECTION_WINDOWS_SEED)
}
// end SP5

async function clearExistingData() {
  const db = getDb()
  // Delete in FK-safe order (children before parents) so seed() is safely re-runnable
  // against the live database without unique-constraint violations.
  await db.delete(rooms)
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
  await db.delete(encounters)
  await db.delete(appointments)
  await db.delete(patients)
  // staffCredentials/staffMembers FK into providers/users, so both must be
  // deleted before providers/users below -- previously missing here, which
  // left a half-wipe FK-violation trap on the shared dev DB (final
  // whole-branch review, Important #1).
  await db.delete(staffCredentials)
  await db.delete(staffMembers)
  await db.delete(providers)
  // SP2: service_catalog references departments; room_categories is
  // referenced by rooms, which were already deleted at the top.
  // tariff_rates and service_package_items reference service_catalog.
  // SP5: lab_tests survive the clear (seedLabTests tops them up) but may point at a service.
  await db.update(labTests).set({ serviceId: null })
  await db.delete(tariffRates)
  await db.delete(servicePackageItems)
  await db.delete(serviceCatalog)
  await db.delete(roomCategories)
  await db.delete(departments)
  await db.delete(users)
  await db.delete(trials)
}

export async function seed() {
  assertSeedAllowed()
  const db = getDb()

  // Payer directory is standalone reference data, independent of whether
  // the rest of the DB has been seeded -- top it up unconditionally (before
  // either branch below, since seedBilling() in both paths looks payers up
  // to backfill insurance_claims.payerId) so a fresh DB always has it, and
  // re-running this script against an already-seeded DB never duplicates it.
  const [{ payerCount }] = await db.select({ payerCount: sql<number>`count(*)::int` }).from(payers)
  if (payerCount === 0) {
    await seedPayers()
    console.log('Seeded payer directory (14 payers).')
  }

  // Medication catalog + inventory is likewise standalone reference data,
  // independent of whether the rest of the DB has been seeded. Unlike
  // seedPayers() above, this is called truly unconditionally (no outer
  // count guard) because seedMedications() itself is fully idempotent
  // per-row for both medications and medicationInventory, so re-running it
  // on every seed() invocation is cheap and never duplicates rows.
  await seedMedications()

  // Lab test catalog is likewise standalone reference data -- top it up
  // unconditionally for the same reason as the payer directory above.
  // Unlike the payerCount check above, this is NOT gated on a top-level
  // count: seedLabTests() is idempotent per-code (see its own comment), so
  // gating it on labTestCount === 0 would mean a single stray lab_tests row
  // (e.g. left over from an interrupted test run) permanently skips seeding
  // the other 9 catalog tests, leaving the "Order labs" dropdown nearly empty.
  await seedLabTests()
  console.log('Seeded lab test catalog (16 tests).')

  // Guard against re-seeding a shared dev database that already has data.
  // Several parallel feature branches now have their own tables with FK
  // references into `patients`/`formSubmissions` (appointments, charges,
  // reviews, ...) that this branch's schema doesn't know about, so a full
  // clear-and-reinsert here can no longer safely delete those two tables --
  // it would abort partway through with a foreign-key violation and leave
  // whatever it deleted first empty. If the DB is already seeded, skip the
  // destructive cycle entirely and leave existing data alone.
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(patients)
  if (count > 0) {
    console.log(`Seed skipped: patients table already has ${count} row(s).`)
    // Even when patients is already seeded, this branch's own new tables
    // (providers/appointments, charges/insuranceClaims/patientStatements/
    // mockPayments, documents/faxes) might not be -- e.g. a shared dev
    // database seeded by a sibling branch before this branch's schema
    // existed. Top those up without touching anything else: every top-up
    // function only inserts into tables this branch owns exclusively,
    // against patients rows already confirmed present, so none carries the
    // deletion/FK risk clearExistingData() has.
    const [{ providerCount }] = await db.select({ providerCount: sql<number>`count(*)::int` }).from(providers)
    if (providerCount === 0) {
      await seedProvidersAndAppointments()
      console.log('Seeded providers/appointments (patients table was already populated).')
    }
    const [{ roomCount }] = await db.select({ roomCount: sql<number>`count(*)::int` }).from(rooms)
    if (roomCount === 0) {
      await seedRooms()
      console.log('Seeded rooms (patients table was already populated).')
    }
    // Staff directory links to both `users` and `providers` by name, so it
    // must run after the providerCount top-up above -- a shared dev DB
    // seeded before this branch's schema existed won't have staff rows yet.
    const [{ staffCount }] = await db.select({ staffCount: sql<number>`count(*)::int` }).from(staffMembers)
    if (staffCount === 0) {
      await seedStaff()
      console.log('Seeded staff directory (patients table was already populated).')
    }
    // seedFillerPatients() skips any id that already exists, so it's safe to
    // call again here to top up the roster with any new FILLER_NAMES entries
    // added since this database was first seeded.
    await seedFillerPatients()
    await seedAdditionalAppointmentsForExpandedRoster()

    const [{ chargeCount }] = await db.select({ chargeCount: sql<number>`count(*)::int` }).from(charges)
    if (chargeCount === 0) {
      await seedBilling()
      console.log('Seeded billing (charges/claims/payments/statements) (patients table was already populated).')
    }
    const [{ documentCount }] = await db.select({ documentCount: sql<number>`count(*)::int` }).from(documents)
    if (documentCount === 0) {
      await seedDocumentsAndFaxes()
      console.log('Seeded documents/faxes (patients table was already populated).')
    }
    return
  }

  await clearExistingData()

  await db.insert(trials).values([MDD_TRIAL, ADHD_TRIAL])
  await seedHomeCollectionWindows() // SP5

  const demoHash = hashPassword(seedDemoPassword())
  await db.insert(users).values([
    // Demo credentials for each staff role, so login isn't admin-only. The
    // real admin account authenticates via ADMIN_EMAIL/ADMIN_PASSWORD_HASH,
    // never through this table -- Sam Patel's row here is inert demo data.
    // Emails use SEED_EMAIL_DOMAIN and the password is SEED_DEMO_PASSWORD
    // (see assertSeedAllowed/seedConfig); neither lives in source.
    { name: 'Sam Patel', email: seedEmail('admin'), role: 'admin', passwordHash: demoHash },
    { name: 'Jamie Ruiz', email: seedEmail('crc'), role: 'crc', passwordHash: demoHash },
    { name: 'Dr. R. Kunam', email: seedEmail('pi'), role: 'pi', passwordHash: demoHash },
    { name: 'Taylor Nguyen', email: seedEmail('frontdesk'), role: 'frontdesk', passwordHash: demoHash },
    { name: 'Robin Shah', email: seedEmail('pharmacy'), role: 'pharmacy', passwordHash: demoHash },
    { name: 'Alex Billing', email: seedEmail('billing'), role: 'billing', passwordHash: demoHash },
    { name: 'Morgan Lee', email: seedEmail('labs'), role: 'labs', passwordHash: demoHash },
    { name: 'Ravi Kumar', email: seedEmail('collector'), role: 'collector', passwordHash: demoHash }, // SP5
  ])

  for (const p of HERO_PATIENTS) {
    await db.insert(patients).values({
      id: p.id,
      name: p.name,
      dob: p.dob,
      city: p.city,
      zip: p.zip,
      phone: p.phone,
      email: p.email,
      currentProvider: p.provider,
      ratingScales: [p.ratingScale],
      referralType: 'Provider referral',
      availability: 'Weekday mornings',
      commConsentSigned: true,
      commConsentPref: 'Phone',
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

  await seedFillerPatients()
  const insertedProviders = await seedProvidersAndAppointments()
  await seedStaff()
  await seedRooms()
  await seedBilling()
  await seedDocumentsAndFaxes()
  await seedTrialCompliance()

  // Demo-only prescribed episodes (prescribedAt IS NOT NULL) for the first
  // hero patient only, added after providers exist so prescribedByProviderId
  // can point at a real row -- gives the print view and prescriber
  // attribution real data to render without hand-writing one. This same
  // patient's imported-history episode inserted above (in the HERO_PATIENTS
  // loop) is left exactly as it is, with prescribedAt still null: a
  // null-prescriber row still rendering correctly alongside these is itself
  // the regression check (see schema.ts comment on medicationEpisodes for
  // why that discriminator must never be backfilled).
  const heroPrescriber = insertedProviders.find((provider) => provider.name === 'Dr. Rajiv Kunam')
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
      prescribedByProviderId: heroPrescriber?.id,
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
      prescribedByProviderId: heroPrescriber?.id,
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
  await db.insert(formSubmissions).values([
    { templateId: mddTemplate.id, patientId: 'RD-0001', status: 'completed', sentDate: new Date('2026-08-10'), completedDate: new Date('2026-08-15'), answers: { q1: 'Maria Alvarez', q4: 'Yes' } },
    { templateId: mddTemplate.id, patientId: 'RD-0002', status: 'completed', sentDate: new Date('2026-08-16'), completedDate: new Date('2026-08-20'), answers: { q1: 'James Thornton', q4: 'Yes' } },
    { templateId: mddTemplate.id, patientId: 'RD-0003', status: 'sent', sentDate: new Date('2026-08-25') },
    { templateId: mddTemplate.id, patientId: 'RD-0006', status: 'partial', sentDate: new Date('2026-08-18'), answers: { q1: 'Kathryn Voss' } },
    { templateId: adhdTemplate.id, patientId: 'RD-0004', status: 'completed', sentDate: new Date('2026-08-17'), completedDate: new Date('2026-08-22'), answers: { q1: 'Priya Natarajan' } },
    { templateId: adhdTemplate.id, patientId: 'RD-0005', status: 'sent', sentDate: new Date('2026-08-24') },
  ])

  // Allergies for a subset of patients.
  await db.insert(allergies).values([
    { patientId: 'RD-0001', allergen: 'Penicillin', reaction: 'Rash', severity: 'moderate' },
    { patientId: 'RD-0002', allergen: 'Sulfa drugs', reaction: 'Hives', severity: 'severe' },
    { patientId: 'RD-0006', allergen: 'Latex', reaction: 'Contact dermatitis', severity: 'mild' },
  ])

  // Identity verification: a mix of verified and pending.
  await db.insert(identityVerifications).values([
    { patientId: 'RD-0001', idType: 'drivers_license', idNumberEncrypted: encryptSensitive('D1234567'), verified: true, verifiedBy: 'Jamie Ruiz', verifiedAt: new Date('2026-08-16') },
    { patientId: 'RD-0002', idType: 'state_id', idNumberEncrypted: encryptSensitive('S7654321'), verified: true, verifiedBy: 'Jamie Ruiz', verifiedAt: new Date('2026-08-21') },
    { patientId: 'RD-0003', idType: 'passport', idNumberEncrypted: encryptSensitive('P9988776'), verified: false },
  ])

  // Default settings row (auto-classify off by default).
  await db.insert(appSettings).values({ autoClassifyOnComplete: false })

  // Phase 5: stagger dateAdded/chartDataAsOf for a handful of patients so the
  // Pipeline Performance Dashboard's date-range filters and "average days
  // referral -> classification" KPI have real spread to show, instead of
  // every patient landing at the exact instant this script ran. This only
  // updates data values on the pre-existing `patients` table (not its
  // schema), for the same reason Phase 1's seed script freely inserts into
  // pre-existing tables like `diagnoses` — no phase "owns" `patients`
  // exclusively, and no column definition is changed here.
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
      message: 'Reminder: your MDD trial intake packet is still open. Please finish it before your next visit.',
      channel: 'sms',
      filterTrialId: 'nct06911112',
      filterOverallStatus: 'yellow',
      filterFormStatus: null,
      recipients: [
        { patientId: 'RD-0003', patientName: 'Linda Cho', deliveryStatus: 'delivered' },
        { patientId: 'RD-0006', patientName: 'Kathryn Voss', deliveryStatus: 'delivered' },
      ],
      recipientCount: 2,
      sentBy: 'Jamie Ruiz',
      sentAt: daysAgo(10),
    },
    {
      subject: 'Your ADHD study forms are complete — next steps',
      message: 'Thank you for completing your intake packet. The study coordinator will call you within 2 business days to schedule your screening visit.',
      channel: 'email',
      filterTrialId: 'nct-adhd-demo-01',
      filterOverallStatus: null,
      filterFormStatus: 'completed',
      recipients: [
        { patientId: 'RD-0004', patientName: 'Priya Natarajan', deliveryStatus: 'delivered' },
      ],
      recipientCount: 1,
      sentBy: 'Jamie Ruiz',
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
        { patientId: 'RD-0003', patientName: 'Linda Cho', deliveryStatus: 'delivered' },
        // A 'both'-channel send only fails when a patient has NEITHER phone
        // nor email (simulateBroadcastDelivery), and RD-0005 has both --
        // 'delivered' is what the simulator would actually produce here.
        { patientId: 'RD-0005', patientName: 'Marcus Webb', deliveryStatus: 'delivered' },
      ],
      recipientCount: 2,
      sentBy: 'Sam Patel',
      sentAt: daysAgo(4),
    },
    {
      message: 'This is a routine check-in from the study team — reply if you have questions about your upcoming visit.',
      channel: 'sms',
      filterTrialId: null,
      filterOverallStatus: null,
      filterFormStatus: null,
      recipients: [
        { patientId: 'RD-0001', patientName: 'Maria Alvarez', deliveryStatus: 'delivered' },
        { patientId: 'RD-0002', patientName: 'James Thornton', deliveryStatus: 'delivered' },
        { patientId: 'RD-0007', patientName: 'Robert Nguyen', deliveryStatus: 'failed' },
      ],
      recipientCount: 3,
      sentBy: 'Jamie Ruiz',
      sentAt: daysAgo(1),
    },
  ])

  // Reviews: Pre-Screening Experience Survey responses tied to Phase 1's
  // completed form submissions for RD-0001, RD-0002, and RD-0004.
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
      sentBy: 'Jamie Ruiz',
    },
    {
      patientId: 'RD-0002',
      formSubmissionId: rd0002Submission.id,
      status: 'sent',
      sentAt: daysAgo(14),
      sentBy: 'Jamie Ruiz',
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
      sentBy: 'Jamie Ruiz',
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
      title: 'Notice of Privacy Practices',
      bodyMarkdown: '[DRAFT -- NOT REVIEWED BY LEGAL COUNSEL. Replace before any real patient relies on this.]\n\nThis notice describes how medical information about you may be used and disclosed, and how you can access this information. We are required by law to maintain the privacy of your protected health information (PHI). You have the right to inspect and copy your records, request corrections, request restrictions on certain uses, and receive an accounting of disclosures.',
      isDraft: true,
      effectiveDate: new Date().toISOString().slice(0, 10),
    },
    {
      type: 'tos',
      version: 1,
      title: 'Terms of Service',
      bodyMarkdown: '[DRAFT -- NOT REVIEWED BY LEGAL COUNSEL. Replace before any real patient relies on this.]\n\nThis portal is not monitored continuously -- if you are experiencing a medical emergency, call 911. Information provided through this portal does not constitute medical advice. You are responsible for keeping your login credentials confidential. Messages are typically reviewed within 1-2 business days. We may suspend or terminate portal access at our discretion.',
      isDraft: true,
      effectiveDate: new Date().toISOString().slice(0, 10),
    },
  ])
}

if (require.main === module) {
  seed().then(
    () => { console.log('Seed complete'); process.exit(0) },
    (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) },
  )
}
