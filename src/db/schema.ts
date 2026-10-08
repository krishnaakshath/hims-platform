import { pgTable, text, timestamp, date, boolean, jsonb, integer, bigint, pgEnum, serial, uniqueIndex, index, pgSequence, check, foreignKey, primaryKey, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
// SP4
import type { ProcedureCodeRef, ChargeViolation, RuleOverride } from '../lib/billing/charge-rules'
import type { InvoiceSnapshot } from '../lib/billing/gst'
// SP7
import type { ClaimSnapshot, CodedEntry, EstimateLine, PreauthSnapshot } from '../lib/rcm/snapshot'
// SP8
import { ABHA_VERIFICATION_SOURCES, ABHA_VERIFIED_VIA, ABDM_CONSENT_PURPOSES, ABDM_CONSENT_GIVEN_BY, PROFILE_SHARE_STATUSES, PROFILE_SHARE_ACK_STATES } from '../lib/abdm/constants'
import {
  NHCX_ENTITY_TYPES, NHCX_DIRECTIONS, NHCX_EXCHANGE_STATES, NHCX_REVIEW_STATES, ELIGIBILITY_PURPOSES, ELIGIBILITY_CONTEXTS, ELIGIBILITY_STATUSES,
  INBOUND_CALL_OUTCOMES, type NhcxResponseSummary,
} from '../lib/nhcx/constants'

export const verdictEnum = pgEnum('verdict', ['green', 'yellow', 'red'])
// SP6: + coder (scripts/migrations/2026-10-07-sp6-a-coder-role.sql)
// SP5: + 'collector' (added by scripts/migrations/2026-10-08-sp5-lab-enum-values.sql)
// SP7: + 'rcm' (last; added by scripts/migrations/2026-10-09-sp7-a-rcm-role.sql)
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'])
export const mfaMethodEnum = pgEnum('mfa_method', ['totp', 'sms', 'email'])
export const payerTypeEnum = pgEnum('payer_type', ['commercial', 'medicare', 'medicaid', 'tricare', 'other'])
export const insuranceRelationshipEnum = pgEnum('insurance_relationship', ['self', 'spouse', 'child', 'other'])
export const insurancePlanTypeEnum = pgEnum('insurance_plan_type', ['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid'])

// SP1 Indian patient master (scripts/migrations/2026-10-07-sp1-patient-master.sql).
export const genderEnum = pgEnum('gender', ['male', 'female', 'transgender', 'other', 'unknown'])
export const maritalStatusEnum = pgEnum('marital_status', ['single', 'married', 'divorced', 'widowed', 'separated', 'unknown'])
export const bloodGroupEnum = pgEnum('blood_group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'])
export const patientContactKindEnum = pgEnum('patient_contact_kind', ['next_of_kin', 'guardian', 'emergency'])
export const registrationCouncilEnum = pgEnum('registration_council', ['nmc', 'smc'])

// UHID numeric part. The prefix lives in app_settings.uhid_prefix.
export const uhidSeq = pgSequence('uhid_seq', { startWith: 1, increment: 1 })

export const trials = pgTable('trials', {
  id: text('id').primaryKey(),                 // e.g. "nct06911112"
  name: text('name').notNull(),
  nctNumber: text('nct_number').notNull(),
  condition: text('condition').notNull(),        // e.g. "Major Depressive Disorder"
  site: text('site').notNull(),
  studyDrug: text('study_drug').notNull(),
  ageMin: integer('age_min').notNull(),
  ageMax: integer('age_max').notNull(),
  diagnosisCodes: jsonb('diagnosis_codes').$type<{ code: string; description: string }[]>().notNull(),
  ratingScales: jsonb('rating_scales').$type<{ name: string; description: string }[]>().notNull(),
  // Two different medication-rule shapes share this column, distinguished
  // by ruleType: 'washout_exclusion' (must NOT be actively on this class
  // within `washoutDays` -- an exclusion criterion, e.g. ADHD's stimulant
  // washout) vs 'required_stable' (must BE actively on this class for at
  // least `washoutDays` -- an inclusion/stability criterion, e.g. MDD's
  // "on current antidepressant >= 8 weeks"). Treating both the same was a
  // real evaluation bug: someone correctly on a stable antidepressant would
  // otherwise be scored as if they were on an excluded medication.
  medicationClasses: jsonb('medication_classes').$type<
    { className: string; washoutDays: number; rule: string; ruleType: 'washout_exclusion' | 'required_stable' }[]
  >().notNull(),
  // Exclusion criteria: diagnoses that disqualify an otherwise-eligible
  // patient (e.g. active psychosis, current substance use disorder) --
  // distinct from medicationClasses above, which is also an exclusion rule
  // but keyed on active medications rather than diagnoses.
  exclusionDiagnoses: jsonb('exclusion_diagnoses').$type<{ code: string; description: string }[]>().default([]).notNull(),
  // Inclusion criterion: minimum severity on the trial's primary rating
  // scale (ratingScales[0]). Null means this trial doesn't gate on score.
  minRatingScaleScore: integer('min_rating_scale_score'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const patients = pgTable('patients', {
  id: text('id').primaryKey(),                  // anonymous id "RD-0001"
  dateAdded: timestamp('date_added').defaultNow().notNull(),
  name: text('name').notNull(),
  dob: date('dob').notNull(),
  city: text('city'),
  zip: text('zip'),
  phone: text('phone'),
  email: text('email'),
  currentProvider: text('current_provider'),
  ratingScales: jsonb('rating_scales').$type<{ name: string; score: number; date: string }[]>().default([]),
  referralType: text('referral_type'),
  availability: text('availability'),
  lastApptDate: date('last_appt_date'),
  nextApptDate: date('next_appt_date'),
  commConsentSigned: boolean('comm_consent_signed').default(false),
  commConsentPref: text('comm_consent_pref'),
  templateDocUrl: text('template_doc_url'),
  prescreeningSentDate: date('prescreening_sent_date'),
  // Staff-owned fields (2, 12, 17-20, 23, 24, 28 in the 30-column map) — never overwritten by refresh
  // Hospital-issued patient portal credential -- distinct from any staff
  // account, scrypt-hashed the same way as lib/password.ts. Null means the
  // patient has no portal access provisioned yet; portal login refuses to
  // even attempt a password check in that case (see api/patient-portal/login),
  // so a patient can only ever reach the portal after staff sets this up
  // for them from inside the app.
  portalPasswordHash: text('portal_password_hash'),
  lastCommunication: text('last_communication'),
  formNotes: text('form_notes'),
  reviewerNotes: text('reviewer_notes'),
  clinicianReviewerNotes: text('clinician_reviewer_notes'),
  piRecommendation: text('pi_recommendation'),
  oldNotes: text('old_notes'),
  oldRecs: text('old_recs'),
  outsideMedsConfirmation: text('outside_meds_confirmation'),
  chartDataAsOf: timestamp('chart_data_as_of').defaultNow().notNull(),
  mfaSecretEncrypted: text('mfa_secret_encrypted'),
  mfaEnabled: boolean('mfa_enabled').default(false).notNull(),
  primaryPayerId: integer('primary_payer_id').references(() => payers.id),
  primaryMemberId: text('primary_member_id'),
  primaryGroupNumber: text('primary_group_number'),
  primaryPlanType: insurancePlanTypeEnum('primary_plan_type'),
  primarySubscriberName: text('primary_subscriber_name'),
  primarySubscriberRelationship: insuranceRelationshipEnum('primary_subscriber_relationship'),
  primaryCardFrontUrl: text('primary_card_front_url'),
  primaryCardBackUrl: text('primary_card_back_url'),
  secondaryPayerId: integer('secondary_payer_id').references(() => payers.id),
  secondaryMemberId: text('secondary_member_id'),
  secondaryGroupNumber: text('secondary_group_number'),
  secondaryPlanType: insurancePlanTypeEnum('secondary_plan_type'),
  secondarySubscriberName: text('secondary_subscriber_name'),
  secondarySubscriberRelationship: insuranceRelationshipEnum('secondary_subscriber_relationship'),
  // -- SP1 Indian patient master. All nullable/additive so other branches'
  // inserts on the shared DB keep working. Aadhaar deliberately does NOT live
  // here (see patientAadhaar) so no whole-row select of patients can carry it.
  // Legacy `city` is reused as city/town; legacy `zip` is kept but registration
  // no longer writes it (pinCode replaces it).
  uhid: text('uhid').unique(),
  gender: genderEnum('gender'),
  maritalStatus: maritalStatusEnum('marital_status'),
  bloodGroup: bloodGroupEnum('blood_group'),
  occupation: text('occupation'),
  nationality: text('nationality').default('IN'),
  religion: text('religion'),
  preferredLanguage: text('preferred_language'),
  photoBlobPath: text('photo_blob_path'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  district: text('district'),
  stateCode: text('state_code'),
  pinCode: text('pin_code'),
  abhaNumber: text('abha_number').unique(),
  abhaAddress: text('abha_address').unique(),
  abhaUnavailableReason: text('abha_unavailable_reason', { enum: ['not_created', 'patient_declined', 'emergency', 'other'] }),
  abhaUnavailableNote: text('abha_unavailable_note'),
  isMlc: boolean('is_mlc').default(false).notNull(),
  mlcNumber: text('mlc_number'),
  // SP5: per-patient notification opt-out (scripts/migrations/2026-10-08-sp5-lab-home-collection.sql).
  notificationOptOut: boolean('notification_opt_out').default(false).notNull(),
  notificationOptOutAt: timestamp('notification_opt_out_at'),
  // SP8: an ABHA verified by ABDM or a Scan & Share (ruling 12). All three or none.
  abhaVerifiedAt: timestamp('abha_verified_at'),
  abhaVerificationSource: text('abha_verification_source', { enum: ABHA_VERIFICATION_SOURCES }),
  abhaVerifiedVia: text('abha_verified_via', { enum: ABHA_VERIFIED_VIA }),
}, (t) => [
  // SP8
  check('patients_abha_verification_complete', sql`(${t.abhaVerifiedAt} IS NULL) = (${t.abhaVerificationSource} IS NULL) AND (${t.abhaVerifiedAt} IS NULL) = (${t.abhaVerifiedVia} IS NULL)`),
  check('patients_abha_verification_source_valid', sql`${t.abhaVerificationSource} IS NULL OR ${t.abhaVerificationSource} IN ('abdm', 'abdm_sandbox_mock')`),
  // abha_verified_via is checked in TypeScript only (ABHA_VERIFIED_VIA): the SP8 migration carries no
  // Aadhaar-named literal, which its static test pins.
])

// SP6 clinical coding enums (scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql). Declared
// here, ahead of the SP6 table block below, because `diagnoses` uses them eagerly.
export const codeSystemKindEnum = pgEnum('code_system_kind', ['icd10', 'icd10pcs', 'snomed', 'loinc', 'hbp'])
export const codeEntryStatusEnum = pgEnum('code_entry_status', ['uncoded', 'proposed', 'coded'])
export const diagnosisTypeEnum = pgEnum('diagnosis_type', ['primary', 'secondary', 'provisional'])
export const encounterCodingStatusEnum = pgEnum('encounter_coding_status', ['uncoded', 'in_progress', 'queried', 'coded', 'finalised'])
export const codingEventActionEnum = pgEnum('coding_event_action', ['claim', 'assign', 'release', 'raise_query', 'resume', 'mark_coded', 'finalise', 'reopen', 'edit_after_coded'])
export const codingQueryStatusEnum = pgEnum('coding_query_status', ['open', 'answered', 'closed', 'withdrawn'])
// end SP6 enums

export const diagnoses = pgTable('diagnoses', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  // Legacy free text, NOT NULL. An SP6-written diagnosis without a code stores code = ''.
  code: text('code').notNull(),
  description: text('description').notNull(),
  date: date('date'),
  // SP6: per-encounter coded diagnoses. All nullable or defaulted, so legacy rows (no
  // encounter) are untouched and read as `uncoded`. Removal is a soft void (voidedAt).
  encounterId: integer('encounter_id').references(() => encounters.id),
  codeId: integer('code_id').references(() => codes.id),
  codeSystemKind: codeSystemKindEnum('code_system_kind'),
  codeDisplay: text('code_display'),
  diagnosisType: diagnosisTypeEnum('diagnosis_type'),
  codingStatus: codeEntryStatusEnum('coding_status').default('uncoded').notNull(),
  sequence: integer('sequence'),
  proposedByName: text('proposed_by_name'),
  proposedAt: timestamp('proposed_at'),
  codedByName: text('coded_by_name'),
  codedAt: timestamp('coded_at'),
  voidedAt: timestamp('voided_at'),
  voidedByName: text('voided_by_name'),
  createdByName: text('created_by_name'),
  createdAt: timestamp('created_at'),
  // end SP6
}, (t) => [
  // SP6
  index('diagnoses_encounter_id_idx').on(t.encounterId),
  uniqueIndex('diagnoses_one_primary_per_encounter').on(t.encounterId).where(sql`${t.diagnosisType} = 'primary' AND ${t.voidedAt} IS NULL`),
  check('diagnoses_coded_complete', sql`${t.codingStatus} <> 'coded' OR (${t.codeId} IS NOT NULL AND ${t.encounterId} IS NOT NULL AND ${t.diagnosisType} IS NOT NULL)`),
  check('diagnoses_proposed_has_code', sql`${t.codingStatus} <> 'proposed' OR ${t.codeId} IS NOT NULL`),
  check('diagnoses_code_kind_pair', sql`(${t.codeId} IS NULL) = (${t.codeSystemKind} IS NULL)`),
])

export const medicationEpisodes = pgTable('medication_episodes', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  name: text('name').notNull(),
  medicationClass: text('medication_class').notNull(),
  dose: text('dose'),
  startDate: date('start_date').notNull(),
  stopDate: date('stop_date'),
  status: text('status', { enum: ['active', 'inactive'] }).notNull(),
  // This table now holds two kinds of row: imported history (Tebra/IntakeQ
  // medication data with no prescriber of record) and prescriptions written
  // here in-app. `prescribedAt IS NOT NULL` is the discriminator between
  // them -- every column below is null on imported-history rows and no
  // backfill ever populates them retroactively (see migrate-prescriptions
  // migration note: fabricating a retroactive prescriber is the exact
  // failure this feature exists to prevent).
  medicationId: integer('medication_id').references(() => medications.id),
  frequencyPerDay: integer('frequency_per_day'),
  durationDays: integer('duration_days'),
  instructions: text('instructions'),
  prescribedByProviderId: integer('prescribed_by_provider_id').references(() => providers.id),
  enteredByName: text('entered_by_name'),
  prescribedAt: timestamp('prescribed_at'),
})

export const patientTrialScreenings = pgTable('patient_trial_screenings', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  trialId: text('trial_id').notNull().references(() => trials.id),
  overallStatus: verdictEnum('overall_status').notNull(),
  // One-to-one with this screening's outcome (a patient is selected for at
  // most one trial at a time), same shape as identityVerifications.verified/
  // verifiedBy/verifiedAt above. selectionConfirmedAt/selectionConfirmedByName
  // live here rather than a side table because there is exactly one
  // confirmation per screening, not a history of them.
  // selectionNotifiedAt is the one field of the three that is never cleared
  // once set: it marks that the patient-facing notification for this
  // selection has already gone out, so a later status re-check does not
  // re-send it even if selectionConfirmedAt/selectionConfirmedByName change.
  selectionConfirmedAt: timestamp('selection_confirmed_at'),
  selectionConfirmedByName: text('selection_confirmed_by_name'),
  selectionNotifiedAt: timestamp('selection_notified_at'),
})

export const screeningCriteriaResults = pgTable('screening_criteria_results', {
  id: serial('id').primaryKey(),
  screeningId: integer('screening_id').notNull().references(() => patientTrialScreenings.id),
  criterionKey: text('criterion_key').notNull(),
  criterionText: text('criterion_text').notNull(),
  // Nullable for backward compatibility with rows written before this
  // column existed (see the seed.ts migration note) -- the UI treats a null
  // type the same as 'inclusion'.
  criterionType: text('criterion_type', { enum: ['inclusion', 'exclusion'] }),
  verdict: verdictEnum('verdict').notNull(),
  evidenceQuote: text('evidence_quote'),
  evidenceSourceDoc: text('evidence_source_doc'),
  evidenceSourceDate: date('evidence_source_date'),
})

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  userName: text('user_name').notNull(),
  role: roleEnum('role'),
  action: text('action').notNull(),
  patientId: text('patient_id'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  details: text('details'),
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: roleEnum('role').notNull(),
  // Nullable: the one real admin account still authenticates via
  // ADMIN_EMAIL/ADMIN_PASSWORD_HASH (see api/login/route.ts) rather than a
  // row here. Set for any other user this pilot provisions a real login
  // for (pi/crc demo accounts). Same scrypt scheme as lib/password.ts.
  passwordHash: text('password_hash'),
  mfaSecretEncrypted: text('mfa_secret_encrypted'),
  mfaEnabled: boolean('mfa_enabled').default(false).notNull(),
  mfaMethod: mfaMethodEnum('mfa_method').default('totp').notNull(),
  phone: text('phone'),
  googleSub: text('google_sub'),
})

export const chargeStatusEnum = pgEnum('charge_status', ['draft', 'pending_approval', 'approved', 'submitted'])
export const insuranceClaimStatusEnum = pgEnum('insurance_claim_status', [
  'rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid',
])
export const statementDeliveryMethodEnum = pgEnum('statement_delivery_method', ['email', 'sms', 'paper'])
export const statementTypeEnum = pgEnum('statement_type', ['initial', 'reminder', 'final_notice'])
export const statementDeliveryStatusEnum = pgEnum('statement_delivery_status', ['delivered', 'failed'])
export const mockPaymentResultEnum = pgEnum('mock_payment_result', ['success', 'failed'])

export const charges = pgTable('charges', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  // Free-text clinician name, matching the existing patients.currentProvider
  // convention -- Phase 2 owns a real `providers` table and hasn't built it
  // yet as of this plan; Phase 3 must not create a dependency on another
  // phase's not-yet-existing schema.
  providerName: text('provider_name').notNull(),
  dateOfService: date('date_of_service').notNull(),
  diagnosisCodes: jsonb('diagnosis_codes').$type<{ code: string; description: string }[]>().notNull(),
  procedureCodes: jsonb('procedure_codes').$type<
    { code: string; description: string; units: number; chargeCents: number }[]
  >().notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: chargeStatusEnum('status').default('draft').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const payers = pgTable('payers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  payerId: text('payer_id').notNull(),
  payerType: payerTypeEnum('payer_type').default('commercial').notNull(),
  // SP4 billing flags (scripts/migrations/2026-10-08-sp4-a-charge-lines.sql). state_code is IN-xx.
  requiresPreauth: boolean('requires_preauth').default(false).notNull(),
  gstin: text('gstin'),
  stateCode: text('state_code'),
  // end SP4
})

export const insuranceClaims = pgTable('insurance_claims', {
  id: serial('id').primaryKey(),
  chargeId: integer('charge_id').notNull().references(() => charges.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  payerName: text('payer_name').notNull(),
  payerId: integer('payer_id').references(() => payers.id),
  billedAmountCents: integer('billed_amount_cents').notNull(),
  paidAmountCents: integer('paid_amount_cents'),
  status: insuranceClaimStatusEnum('status').notNull(),
  submittedDate: date('submitted_date').notNull(),
  notes: text('notes'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const patientStatements = pgTable('patient_statements', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  amountCents: integer('amount_cents').notNull(),
  deliveryMethod: statementDeliveryMethodEnum('delivery_method').notNull(),
  type: statementTypeEnum('type').notNull(),
  deliveryStatus: statementDeliveryStatusEnum('delivery_status').notNull(),
  sentDate: timestamp('sent_date').defaultNow().notNull(),
})

// SAFETY (see Global Constraints "Mock-payment safety rule"): this table
// stores only the last 4 digits of a card number and never a full PAN or a
// CVC -- there is no column here capable of holding either. `result` is
// decided purely by a fake Luhn-checksum pass/fail, never a real payment
// processor response.
export const mockPayments = pgTable('mock_payments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  chargeId: integer('charge_id').references(() => charges.id),
  amountCents: integer('amount_cents').notNull(),
  cardLast4: text('card_last4').notNull(),
  expMonth: integer('exp_month').notNull(),
  expYear: integer('exp_year').notNull(),
  result: mockPaymentResultEnum('result').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const formSubmissionStatusEnum = pgEnum('form_submission_status', ['sent', 'partial', 'completed'])
export const idTypeEnum = pgEnum('id_type', ['drivers_license', 'state_id', 'passport', 'military_id', 'green_card', 'voter_id', 'pan', 'ration_card'])
export const severityEnum = pgEnum('severity', ['mild', 'moderate', 'severe'])

export const formTemplateFolders = pgTable('form_template_folders', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const legalReviewStatusEnum = pgEnum('legal_review_status', ['draft', 'reviewed'])

// The wording here is deliberately NOT copied into formSubmissionConsents --
// signatures.attestationText is the one verbatim record of what was actually
// agreed to, and a second copy would be a second source of truth that can
// silently disagree with the first.
export const consentDocuments = pgTable('consent_documents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  bodyText: text('body_text').notNull(),
  legalReviewStatus: legalReviewStatusEnum('legal_review_status').default('draft').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const formTemplates = pgTable('form_templates', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),          // folder grouping in the library UI, e.g. "Trial Intake", "Consent Forms", "Screening Questionnaires"
  // Where the template sits in the /forms library UI -- deliberately a
  // separate column from `category`, not a repurposing of it. `category` is
  // the live gate in the sign route and in the patient portal's decision to
  // render SignConsentFormAction, so reusing it as a folder name would break
  // consent signing for every existing submission the moment a folder was
  // renamed (spec §2). Nullable: an un-foldered template is a first-class
  // case, shown as its own card.
  folderId: integer('folder_id').references(() => formTemplateFolders.id),
  diagnosisTag: text('diagnosis_tag').notNull(),
  questions: jsonb('questions').$type<{
    id: string
    label: string
    type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'
    options?: string[]
    optionScores?: (number | null)[] // NEW -- same length/order as options when present; a select question with no optionScores is simply unscored
    hipaaSensitive: boolean
    required: boolean
    autofillField?: 'name' | 'dob' | 'email' | 'phone' | null
    // Tags a question as self-reporting something checkable against the
    // patient's actual chart -- e.g. "Currently taking antidepressants?"
    // against medicationEpisodes. Optional; most questions (free-text
    // symptom descriptions, consent checkboxes) have nothing to compare
    // against and simply omit this.
    compareToChart?: { type: 'medication_active'; medicationClass: string } | null
  }[]>().notNull(),
  scoringRule: jsonb('scoring_rule').$type<{
    questionIds: string[]
    bands: { min: number; max: number; label: string }[]
  } | null>(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const formSubmissions = pgTable('form_submissions', {
  id: serial('id').primaryKey(),
  templateId: integer('template_id').notNull().references(() => formTemplates.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  status: formSubmissionStatusEnum('status').default('sent').notNull(),
  sentDate: timestamp('sent_date').defaultNow().notNull(),
  completedDate: timestamp('completed_date'),
  answers: jsonb('answers').$type<Record<string, string>>().default({}),
  accessToken: text('access_token').unique(),
  tokenExpiresAt: timestamp('token_expires_at'),
})

// Which consent documents are attached to which template. UNIQUE on
// (formTemplateId, consentDocumentId) as a real DB unique index -- attaching
// the same document twice is a mistake, not a supported configuration, and
// an app-level check alone would let two concurrent attaches through.
export const formTemplateConsents = pgTable('form_template_consents', {
  id: serial('id').primaryKey(),
  formTemplateId: integer('form_template_id').notNull().references(() => formTemplates.id),
  consentDocumentId: integer('consent_document_id').notNull().references(() => consentDocuments.id),
  sortOrder: integer('sort_order').default(0).notNull(),
}, (t) => [uniqueIndex('form_template_consents_template_document_unique').on(t.formTemplateId, t.consentDocumentId)])

// The per-submission instance of an attached consent -- created when a form
// is sent, one row per consent document attached to the template at that
// moment. This is the row a signature points at.
export const formSubmissionConsents = pgTable('form_submission_consents', {
  id: serial('id').primaryKey(),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id),
  consentDocumentId: integer('consent_document_id').notNull().references(() => consentDocuments.id),
  sortOrder: integer('sort_order').default(0).notNull(),
})

// Dual verification between what a patient self-reports on an intake form
// and what their actual chart (diagnoses/medications, sourced from Tebra/
// IntakeQ) shows -- distinct from the existing Dual-Sourced Fields
// comparison, which only checks demographic fields (name/DOB/email)
// between the two source systems, never clinical content. Populated when a
// form submission is marked completed; see lib/form-chart-discrepancy.ts.
export const formChartDiscrepancies = pgTable('form_chart_discrepancies', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id),
  questionId: text('question_id').notNull(),
  questionLabel: text('question_label').notNull(),
  patientAnswer: text('patient_answer').notNull(),
  chartFinding: text('chart_finding').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolved: boolean('resolved').default(false).notNull(),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at'),
})

// One row per completed, scoreable submission. A side table, not columns on
// formSubmissions -- a score is computed once at completion and never
// edited, a different write pattern from `answers`, which is written
// incrementally as the patient progresses. See lib/queries/form-submission-scoring.ts.
export const formSubmissionScores = pgTable('form_submission_scores', {
  id: serial('id').primaryKey(),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id).unique(),
  totalScore: integer('total_score').notNull(),
  bandLabel: text('band_label').notNull(),
  computedAt: timestamp('computed_at').defaultNow().notNull(),
})

export const broadcastChannelEnum = pgEnum('broadcast_channel', ['sms', 'email', 'both'])
// Distinct from Phase 1's formSubmissionStatusEnum: a broadcast filter also
// needs to express "patients with no form submission at all", which isn't a
// real formSubmissions.status value — so this is its own enum, not a reuse
// or modification of Phase 1's.
export const broadcastFormStatusFilterEnum = pgEnum('broadcast_form_status_filter', ['sent', 'partial', 'completed', 'none'])
export const surveyStatusEnum = pgEnum('survey_status', ['sent', 'completed'])

export const broadcasts = pgTable('broadcasts', {
  id: serial('id').primaryKey(),
  subject: text('subject'),                    // required by the API when channel includes email; null for sms-only sends
  message: text('message').notNull(),
  channel: broadcastChannelEnum('channel').notNull(),
  filterTrialId: text('filter_trial_id').references(() => trials.id),
  filterOverallStatus: verdictEnum('filter_overall_status'),
  filterFormStatus: broadcastFormStatusFilterEnum('filter_form_status'),
  // Snapshot of exactly who this broadcast went to and whether each
  // recipient's simulated delivery succeeded, captured at send time so
  // history remains accurate even if a patient's contact info changes later.
  recipients: jsonb('recipients').$type<{ patientId: string; patientName: string; deliveryStatus: 'delivered' | 'failed' }[]>().notNull(),
  recipientCount: integer('recipient_count').notNull(),
  sentBy: text('sent_by').notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
})

export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id),
  status: surveyStatusEnum('status').default('sent').notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
  respondedAt: timestamp('responded_at'),
  ratingOverall: integer('rating_overall'),          // 1-5, set only once status = 'completed'
  ratingFormsClarity: integer('rating_forms_clarity'), // 1-5
  ratingCommunication: integer('rating_communication'), // 1-5
  comments: text('comments'),
  sentBy: text('sent_by').notNull(),
})

export const allergies = pgTable('allergies', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  allergen: text('allergen').notNull(),
  reaction: text('reaction'),
  severity: severityEnum('severity').notNull(),
})

export const identityVerifications = pgTable('identity_verifications', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id).unique(),
  idType: idTypeEnum('id_type').notNull(),
  idNumberEncrypted: text('id_number_encrypted').notNull(),
  verified: boolean('verified').default(false).notNull(),
  verifiedBy: text('verified_by'),
  verifiedAt: timestamp('verified_at'),
})

// NOK / guardian / emergency contacts for a patient (SP1).
export const patientContacts = pgTable('patient_contacts', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  kind: patientContactKindEnum('kind').notNull(),
  name: text('name').notNull(),
  relationship: text('relationship').notNull(),
  phone: text('phone').notNull(),
  addressText: text('address_text'),
  isPrimary: boolean('is_primary').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('patient_contacts_patient_id_idx').on(t.patientId)])

// Aadhaar, one row per patient, kept off `patients` on purpose. Either an
// encrypted value (with consent and last 4) or a recorded decline reason --
// never both, never neither (enforced by the check constraint).
export const patientAadhaar = pgTable('patient_aadhaar', {
  patientId: text('patient_id').primaryKey().references(() => patients.id),
  aadhaarEncrypted: text('aadhaar_encrypted'),
  aadhaarLast4: text('aadhaar_last4'),
  consentGiven: boolean('consent_given').default(false).notNull(),
  consentRecordedAt: timestamp('consent_recorded_at'),
  declineReason: text('decline_reason', { enum: ['patient_declined', 'not_available', 'minor_no_aadhaar', 'emergency', 'foreign_national', 'other'] }),
  declineNote: text('decline_note'),
  recordedByName: text('recorded_by_name').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [check('patient_aadhaar_value_xor_decline', sql`(${t.aadhaarEncrypted} IS NOT NULL AND ${t.aadhaarLast4} ~ '^[0-9]{4}$' AND ${t.consentGiven} AND ${t.declineReason} IS NULL) OR (${t.aadhaarEncrypted} IS NULL AND ${t.aadhaarLast4} IS NULL AND ${t.declineReason} IS NOT NULL)`)])

// Single-row table: one settings record for the whole pilot deployment.
export const appSettings = pgTable('app_settings', {
  id: serial('id').primaryKey(),
  autoClassifyOnComplete: boolean('auto_classify_on_complete').default(false).notNull(),
  practiceName: text('practice_name'),
  practiceSite: text('practice_site'),
  practiceTimezone: text('practice_timezone').default('Asia/Kolkata'),
  uhidPrefix: text('uhid_prefix').default('UH').notNull(),
  // The admin account authenticates via ADMIN_EMAIL/ADMIN_PASSWORD_HASH env
  // vars (api/login/route.ts), not a users row -- its MFA state has nowhere
  // else to live, so it goes on this pilot-wide singleton instead.
  adminMfaSecretEncrypted: text('admin_mfa_secret_encrypted'),
  adminMfaEnabled: boolean('admin_mfa_enabled').default(false).notNull(),
  adminMfaMethod: mfaMethodEnum('admin_mfa_method').default('totp').notNull(),
  adminPhone: text('admin_phone'),
  // Plaintext by design, not AES-encrypted like the *Encrypted credential
  // columns above -- this is a shared lobby-device PIN, not a third-party
  // credential or PHI. See this plan's "Scope decisions" #4.
  queueDisplayPin: text('queue_display_pin'),
})

export const appointmentStatusEnum = pgEnum('appointment_status', ['scheduled', 'completed', 'cancelled', 'no_show'])

// A real, structured provider roster for scheduling. Deliberately NOT
// backfilled from `patients.currentProvider` — see the Design Decision
// section in this phase's plan (docs/superpowers/plans/2026-09-17-phase2-scheduling.md)
// for the reasoning: that free-text field has almost no diversity to backfill
// from and lacks the structured fields (credentials, specialty, calendar
// color) a real scheduling feature needs. `colorTag` is always one of the
// design system's grayscale chart tokens ('chart-1'..'chart-5', defined in
// src/app/globals.css) — enforced at the application layer (see the seed
// roster and PROVIDER_DOT_CLASSNAME map in later tasks), not as a DB enum,
// since it's a display concern rather than a domain invariant.
export const providers = pgTable('providers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  credentials: text('credentials'),
  specialty: text('specialty').notNull(),
  colorTag: text('color_tag').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // SP1: department, NMC/SMC registration and consultation fee (integer paise).
  departmentId: integer('department_id').references(() => departments.id),
  registrationCouncil: registrationCouncilEnum('registration_council'),
  registrationStateCode: text('registration_state_code'),
  registrationNumber: text('registration_number'),
  consultationFeePaise: integer('consultation_fee_paise'),
  currency: text('currency').default('INR').notNull(),
}, (t) => [check('providers_consultation_fee_nonneg', sql`${t.consultationFeePaise} IS NULL OR ${t.consultationFeePaise} >= 0`)])

export const departmentKindEnum = pgEnum('department_kind', ['clinical', 'diagnostic', 'support', 'administrative'])

export const departments = pgTable('departments', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),          // ^[A-Z][A-Z0-9_]{1,15}$
  name: text('name').notNull(),
  kind: departmentKindEnum('kind').default('clinical').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export type Department = typeof departments.$inferSelect

// SP2 service/charge master (scripts/migrations/2026-10-07-sp2-service-catalog.sql).
export const serviceCategoryEnum = pgEnum('service_category', [
  'consultation', 'procedure', 'investigation_lab', 'investigation_imaging', 'room_rent',
  'nursing', 'pharmacy', 'consumable', 'package', 'other',
])

export const serviceCatalog = pgTable('service_catalog', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),          // ^[A-Z][A-Z0-9_]{1,15}$
  name: text('name').notNull(),
  departmentId: integer('department_id').notNull().references(() => departments.id),
  category: serviceCategoryEnum('category').notNull(),
  hsnSac: text('hsn_sac').notNull(),
  // GST in basis points (1800 = 18%); CGST/SGST/IGST split is SP4.
  gstRateBp: integer('gst_rate_bp').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  // SP4 billing flags (scripts/migrations/2026-10-08-sp4-a-charge-lines.sql).
  requiresPreauth: boolean('requires_preauth').default(false).notNull(),
  maxQuantity: integer('max_quantity'),
  // end SP4
}, (t) => [
  check('service_catalog_gst_rate_bp_allowed', sql`${t.gstRateBp} IN (0, 500, 1200, 1800, 2800, 4000)`),
  index('service_catalog_department_idx').on(t.departmentId),
  // SP4
  check('service_catalog_max_quantity_range', sql`${t.maxQuantity} IS NULL OR ${t.maxQuantity} BETWEEN 1 AND 1000`),
])

export type ServiceCatalogRow = typeof serviceCatalog.$inferSelect

// SP2 effective-dated tariff rates (scripts/migrations/2026-10-07-sp2-tariff-rates.sql).
// MIGRATION-ONLY CONSTRAINT: `tariff_rates_no_overlap`, an EXCLUDE USING gist
// (needs btree_gist) over (service_id, scope, coalesce(department_id,0),
// coalesce(payer_id,0), coalesce(room_category_id,0), coalesce(ward,''),
// daterange(valid_from, valid_to, '[]')) WHERE deactivated_at IS NULL.
// drizzle cannot express it, so it exists only in that migration: after
// `db:push` on a fresh DB, apply the SP2 migrations (docs/DEPLOYING.md §4),
// and never `db:push` against a DB that has it (push would drop it).
export const TARIFF_SCOPES = ['base', 'department', 'payer'] as const

export const tariffRates = pgTable('tariff_rates', {
  id: serial('id').primaryKey(),
  serviceId: integer('service_id').notNull().references(() => serviceCatalog.id),
  scope: text('scope', { enum: TARIFF_SCOPES }).notNull(),     // text, not pgEnum: used inside the gist exclusion
  departmentId: integer('department_id').references(() => departments.id),
  payerId: integer('payer_id').references(() => payers.id),
  roomCategoryId: integer('room_category_id').references(() => roomCategories.id),
  ward: text('ward'),                                             // stored normalised (normalizeWard, Task 5)
  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').default('INR').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),                                      // inclusive; null = open-ended
  deactivatedAt: timestamp('deactivated_at'),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  check('tariff_rates_amount_nonneg', sql`${t.amountPaise} >= 0`),
  check('tariff_rates_range_ordered', sql`${t.validTo} IS NULL OR ${t.validTo} >= ${t.validFrom}`),
  check('tariff_rates_scope_keys', sql`(${t.scope} = 'base' AND ${t.departmentId} IS NULL AND ${t.payerId} IS NULL) OR (${t.scope} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.payerId} IS NULL) OR (${t.scope} = 'payer' AND ${t.payerId} IS NOT NULL AND ${t.departmentId} IS NULL)`),
  index('tariff_rates_service_idx').on(t.serviceId),
])

export type TariffRateRow = typeof tariffRates.$inferSelect

export const servicePackageItems = pgTable('service_package_items', {
  id: serial('id').primaryKey(),
  packageServiceId: integer('package_service_id').notNull().references(() => serviceCatalog.id),
  itemServiceId: integer('item_service_id').notNull().references(() => serviceCatalog.id),
  quantity: integer('quantity').default(1).notNull(),
}, (t) => [
  uniqueIndex('service_package_items_pkg_item_unique').on(t.packageServiceId, t.itemServiceId),
  check('service_package_items_qty_positive', sql`${t.quantity} > 0`),
  check('service_package_items_not_self', sql`${t.packageServiceId} <> ${t.itemServiceId}`),
])

export const appointments = pgTable('appointments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  providerId: integer('provider_id').notNull().references(() => providers.id),
  startsAt: timestamp('starts_at').notNull(),
  endsAt: timestamp('ends_at').notNull(),
  visitReason: text('visit_reason').notNull(),
  status: appointmentStatusEnum('status').default('scheduled').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const telemedicineSessionStatusEnum = pgEnum('telemedicine_session_status', [
  'scheduled', 'waiting', 'in_progress', 'completed', 'failed',
])

export const telemedicineSessions = pgTable('telemedicine_sessions', {
  id: serial('id').primaryKey(),
  appointmentId: integer('appointment_id').notNull().references(() => appointments.id).unique(),
  patientJoinToken: text('patient_join_token').notNull().unique(),
  status: telemedicineSessionStatusEnum('status').default('scheduled').notNull(),
  providerJoinedAt: timestamp('provider_joined_at'),
  patientJoinedAt: timestamp('patient_joined_at'),
  endedAt: timestamp('ended_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const telemedicineSignalTypeEnum = pgEnum('telemedicine_signal_type', ['offer', 'answer', 'ice_candidate'])
export const telemedicineSignalSenderEnum = pgEnum('telemedicine_signal_sender', ['provider', 'patient'])

export const telemedicineSignals = pgTable('telemedicine_signals', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').notNull().references(() => telemedicineSessions.id),
  sender: telemedicineSignalSenderEnum('sender').notNull(),
  signalType: telemedicineSignalTypeEnum('signal_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const bookingRequestStatusEnum = pgEnum('booking_request_status', ['pending', 'confirmed', 'declined'])

export const bookingRequests = pgTable('booking_requests', {
  id: serial('id').primaryKey(),
  requesterName: text('requester_name').notNull(),
  requesterDob: date('requester_dob').notNull(),
  requesterEmail: text('requester_email'),
  requesterPhone: text('requester_phone'),
  preferredProviderId: integer('preferred_provider_id').references(() => providers.id),
  preferredDateRangeStart: date('preferred_date_range_start').notNull(),
  preferredDateRangeEnd: date('preferred_date_range_end').notNull(),
  reason: text('reason').notNull(),
  status: bookingRequestStatusEnum('status').default('pending').notNull(),
  submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  reviewedByName: text('reviewed_by_name'),
  reviewedAt: timestamp('reviewed_at'),
  declineReason: text('decline_reason'),
  resultingAppointmentId: integer('resulting_appointment_id').references(() => appointments.id),
  // Wave J (P1-20): portal requests (scripts/migrations/2026-10-10-wave-j-portal-appointment-requests.sql).
  // Public /book rows keep kind 'new' with no patient and no appointment.
  patientId: text('patient_id').references(() => patients.id),
  requestKind: text('request_kind', { enum: ['new', 'reschedule', 'cancel'] }).default('new').notNull(),
  appointmentId: integer('appointment_id').references(() => appointments.id),
  // end Wave J
}, (t) => [
  // Wave J
  check('booking_requests_request_kind_valid', sql`${t.requestKind} IN ('new', 'reschedule', 'cancel')`),
  check('booking_requests_kind_shape', sql`(${t.requestKind} = 'new' AND ${t.appointmentId} IS NULL) OR (${t.requestKind} <> 'new' AND ${t.appointmentId} IS NOT NULL AND ${t.patientId} IS NOT NULL)`),
  index('booking_requests_patient_idx').on(t.patientId),
  uniqueIndex('booking_requests_one_pending_per_appointment').on(t.appointmentId).where(sql`status = 'pending' AND appointment_id IS NOT NULL`),
  // end Wave J
])

export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied', 'dirty', 'blocked'])

// SP2 tariff master (scripts/migrations/2026-10-07-sp2-service-catalog.sql).
export const roomCategories = pgTable('room_categories', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),          // ^[A-Z][A-Z0-9_]{1,15}$
  name: text('name').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export type RoomCategory = typeof roomCategories.$inferSelect

export const rooms = pgTable('rooms', {
  id: serial('id').primaryKey(),
  ward: text('ward').notNull(),
  roomNumber: text('room_number').notNull(),
  bedNumber: text('bed_number').notNull(),
  status: roomStatusEnum('status').default('available').notNull(),
  blockedReason: text('blocked_reason'),
  occupiedByPatientId: text('occupied_by_patient_id').references(() => patients.id),
  // SP2: tariff room category (nullable; rooms predate categories).
  roomCategoryId: integer('room_category_id').references(() => roomCategories.id),
})

export const doctorAssignmentVisitTypeEnum = pgEnum('doctor_assignment_visit_type', ['inpatient', 'outpatient'])
export const doctorAssignmentUrgencyEnum = pgEnum('doctor_assignment_urgency', ['routine', 'urgent', 'emergency'])
export const doctorAssignmentStatusEnum = pgEnum('doctor_assignment_status', ['pending', 'scheduled', 'declined'])

export const doctorAssignments = pgTable('doctor_assignments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  providerId: integer('provider_id').notNull().references(() => providers.id),
  visitType: doctorAssignmentVisitTypeEnum('visit_type').notNull(),
  urgency: doctorAssignmentUrgencyEnum('urgency').default('routine').notNull(),
  reason: text('reason').notNull(),
  status: doctorAssignmentStatusEnum('status').default('pending').notNull(),
  roomId: integer('room_id').references(() => rooms.id),
  assignedByName: text('assigned_by_name').notNull(),
  appointmentId: integer('appointment_id').references(() => appointments.id),
  declineReason: text('decline_reason'),
  // DEFAULT 0 is a safety net, not a real ticket number -- this is a single
  // shared Neon DB used by every branch/worktree in this repo, and other
  // branches' code (unaware of this column) inserts doctorAssignments rows
  // without setting it. Real assignments always get a real sequential
  // number explicitly from the ticket-generation code (see Task 2), which
  // never relies on this default.
  queueTicketNumber: integer('queue_ticket_number').notNull().default(0),
  // Notification columns -- added by scripts/migrations/2026-10-04-assignment-notifications.sql
  // (nullable, additive). patientNotifiedAt is NEVER cleared once set (spec §8).
  patientNotifiedAt: timestamp('patient_notified_at'),
  declineAcknowledgedAt: timestamp('decline_acknowledged_at'),
  declineAcknowledgedByName: text('decline_acknowledged_by_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const admissionTypeEnum = pgEnum('admission_type', ['elective', 'emergency', 'transfer_in'])
export const admissionStatusEnum = pgEnum('admission_status', ['admitted', 'discharged'])

export const admissions = pgTable('admissions', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  currentRoomId: integer('current_room_id').references(() => rooms.id),
  attendingProviderId: integer('attending_provider_id').notNull().references(() => providers.id),
  admissionType: admissionTypeEnum('admission_type').default('elective').notNull(),
  status: admissionStatusEnum('status').default('admitted').notNull(),
  admittedAt: timestamp('admitted_at').defaultNow().notNull(),
  dischargedAt: timestamp('discharged_at'),
  dischargeDiagnosis: text('discharge_diagnosis'),
  dischargeDrugs: text('discharge_drugs'),
  dischargeDevices: text('discharge_devices'),
  dischargeDiet: text('discharge_diet'),
  dischargeSummaryNotes: text('discharge_summary_notes'),
  followUpAppointmentId: integer('follow_up_appointment_id').references(() => appointments.id),
  createdFromAssignmentId: integer('created_from_assignment_id').references(() => doctorAssignments.id),
})

export const admissionTransfers = pgTable('admission_transfers', {
  id: serial('id').primaryKey(),
  admissionId: integer('admission_id').notNull().references(() => admissions.id),
  fromRoomId: integer('from_room_id').references(() => rooms.id),
  toRoomId: integer('to_room_id').notNull().references(() => rooms.id),
  reason: text('reason').notNull(),
  transferredByName: text('transferred_by_name').notNull(),
  transferredAt: timestamp('transferred_at').defaultNow().notNull(),
})

// SP3 encounters & follow-up (scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql)
export const encounterTypeEnum = pgEnum('encounter_type', ['opd', 'ipd', 'lab'])
export const encounterVisitTypeEnum = pgEnum('encounter_visit_type', ['new', 'follow_up', 'review', 'emergency'])
export const encounterStatusEnum = pgEnum('encounter_status', ['checked_in', 'in_consultation', 'completed', 'cancelled'])
export const followUpStatusEnum = pgEnum('follow_up_status', ['planned', 'scheduled', 'completed', 'missed', 'cancelled'])
export const followUpSourceEnum = pgEnum('follow_up_source', ['encounter', 'discharge', 'lab_report', 'manual'])
export const followUpIntervalUnitEnum = pgEnum('follow_up_interval_unit', ['days', 'weeks', 'months'])
export const followUpContactChannelEnum = pgEnum('follow_up_contact_channel', ['phone', 'sms', 'whatsapp', 'email', 'in_person'])
export const followUpContactOutcomeEnum = pgEnum('follow_up_contact_outcome', ['reached_booked', 'reached_will_call_back', 'reached_declined', 'no_answer', 'wrong_number', 'message_left'])

// SP3: one row per visit (OPD) or stay (IPD), created at check-in. encounter_date is the
// Asia/Kolkata business date; the OPD token restarts per IST date.
export const encounters = pgTable('encounters', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  encounterType: encounterTypeEnum('encounter_type').notNull(),
  visitType: encounterVisitTypeEnum('visit_type').default('new').notNull(),
  status: encounterStatusEnum('status').default('checked_in').notNull(),
  encounterDate: date('encounter_date').notNull(),
  opdToken: integer('opd_token'),
  departmentId: integer('department_id').references(() => departments.id),
  providerId: integer('provider_id').notNull().references(() => providers.id),
  appointmentId: integer('appointment_id').references(() => appointments.id, { onDelete: 'set null' }).unique(),
  admissionId: integer('admission_id').references(() => admissions.id, { onDelete: 'set null' }).unique(),
  doctorAssignmentId: integer('doctor_assignment_id').references(() => doctorAssignments.id, { onDelete: 'set null' }).unique(),
  checkedInByName: text('checked_in_by_name').notNull(),
  checkedInAt: timestamp('checked_in_at').defaultNow().notNull(),
  statusChangedAt: timestamp('status_changed_at'),
  statusChangedByName: text('status_changed_by_name'),
  completedAt: timestamp('completed_at'),
  cancelReason: text('cancel_reason'),
}, (t) => [
  uniqueIndex('encounters_date_token_unique').on(t.encounterDate, t.opdToken),
  index('encounters_patient_id_idx').on(t.patientId),
  check('encounters_token_positive', sql`${t.opdToken} IS NULL OR ${t.opdToken} > 0`),
])

// SP3: a prescribed return visit. Provenance links are ON DELETE SET NULL so deleting an
// appointment/admission/encounter never trips on a follow-up; the derived status
// (deriveFollowUpStatus) treats a scheduled order whose appointment vanished as planned.
export const followUpOrders = pgTable('follow_up_orders', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  source: followUpSourceEnum('source').notNull(),
  status: followUpStatusEnum('status').default('planned').notNull(),
  prescribedByProviderId: integer('prescribed_by_provider_id').notNull().references(() => providers.id),
  departmentId: integer('department_id').references(() => departments.id),
  baseDate: date('base_date').notNull(),          // the date the interval counts from
  dueDate: date('due_date').notNull(),
  windowStart: date('window_start').notNull(),
  windowEnd: date('window_end').notNull(),
  intervalValue: integer('interval_value'),
  intervalUnit: followUpIntervalUnitEnum('interval_unit'),
  reason: text('reason').notNull(),
  planNotes: text('plan_notes'),
  originatingEncounterId: integer('originating_encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
  originatingAdmissionId: integer('originating_admission_id').references(() => admissions.id, { onDelete: 'set null' }),
  // SP5 placeholder: SP3 never writes this.
  originatingLabOrderId: integer('originating_lab_order_id').references(() => labOrders.id, { onDelete: 'set null' }),
  appointmentId: integer('appointment_id').references(() => appointments.id, { onDelete: 'set null' }).unique(),
  completedEncounterId: integer('completed_encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
  createdByName: text('created_by_name').notNull(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  planUpdatedAt: timestamp('plan_updated_at'),
  planUpdatedByName: text('plan_updated_by_name'),
  scheduledAt: timestamp('scheduled_at'),
  scheduledByName: text('scheduled_by_name'),
  scheduledByUserId: integer('scheduled_by_user_id').references(() => users.id),
  completedAt: timestamp('completed_at'),
  cancelledAt: timestamp('cancelled_at'),
  cancelledByName: text('cancelled_by_name'),
  cancelReason: text('cancel_reason'),
}, (t) => [
  index('follow_up_orders_patient_id_idx').on(t.patientId),
  index('follow_up_orders_status_window_idx').on(t.status, t.windowEnd),
  check('follow_up_orders_window_order', sql`${t.windowStart} <= ${t.dueDate} AND ${t.dueDate} <= ${t.windowEnd}`),
  check('follow_up_orders_interval_pair', sql`(${t.intervalValue} IS NULL) = (${t.intervalUnit} IS NULL) AND (${t.intervalValue} IS NULL OR ${t.intervalValue} > 0)`),
  check('follow_up_orders_cancel_reason', sql`${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL`),
])

export const followUpContactAttempts = pgTable('follow_up_contact_attempts', {
  id: serial('id').primaryKey(),
  followUpOrderId: integer('follow_up_order_id').notNull(),
  channel: followUpContactChannelEnum('channel').notNull(),
  outcome: followUpContactOutcomeEnum('outcome').notNull(),
  note: text('note'),
  attemptedByName: text('attempted_by_name').notNull(),
  attemptedByUserId: integer('attempted_by_user_id').references(() => users.id),
  attemptedAt: timestamp('attempted_at').defaultNow().notNull(),
}, (t) => [
  // Explicit name: drizzle's default would be 68 characters, over Postgres's 63-character limit.
  foreignKey({ name: 'follow_up_contact_attempts_order_id_fk', columns: [t.followUpOrderId], foreignColumns: [followUpOrders.id] }).onDelete('cascade'),
  index('follow_up_contact_attempts_order_idx').on(t.followUpOrderId),
  check('follow_up_contact_attempts_note_len', sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
])

export type EncounterRow = typeof encounters.$inferSelect
export type FollowUpOrderRow = typeof followUpOrders.$inferSelect
export type FollowUpContactAttemptRow = typeof followUpContactAttempts.$inferSelect

// SP4 charge capture & GST invoices.
// Migration A: scripts/migrations/2026-10-08-sp4-a-charge-lines.sql (settings, rule config, charge lines).
// Money: per-unit prices and configured amounts are int4 paise capped at MAX_AMOUNT_PAISE;
// every computed amount is bigint paise (mode 'number', capped at MAX_DOCUMENT_PAISE < 2^53).
// No SP4 FK has an ON DELETE action: deletePatient clears a patient's lines explicitly.
export const chargeLineSourceEnum = pgEnum('charge_line_source', ['manual', 'room_rent', 'pharmacy'])
export const chargeLineStatusEnum = pgEnum('charge_line_status', ['captured', 'invoiced', 'void'])
export const PRICE_SOURCES = ['base', 'department', 'payer', 'manual', 'pharmacy'] as const

// Singleton (id = 1), inserted by migration A. Never cleared by the seed.
export const billingSettings = pgTable('billing_settings', {
  id: integer('id').primaryKey().default(1),
  legalName: text('legal_name'),
  gstin: text('gstin'),
  stateCode: text('state_code'),                  // IN-xx
  address: text('address'),
  placeOfSupplyMode: text('place_of_supply_mode', { enum: ['location_of_service', 'recipient_state'] }).default('location_of_service').notNull(),
  consultationWindowDays: integer('consultation_window_days').default(30).notNull(),
  ipdDepositThresholdPaise: integer('ipd_deposit_threshold_paise').default(0).notNull(),
  roomRentServiceId: integer('room_rent_service_id').references(() => serviceCatalog.id),
  pharmacyGstRateBp: integer('pharmacy_gst_rate_bp').default(500).notNull(),
  pharmacyHsn: text('pharmacy_hsn').default('3004').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedByName: text('updated_by_name'),
  // SP7 hospital identifiers for claims (scripts/migrations/2026-10-09-sp7-b-payers-policies.sql)
  rohiniId: text('rohini_id'),
  hfrId: text('hfr_id'),
  // end SP7
}, (t) => [
  check('billing_settings_singleton', sql`${t.id} = 1`),
  check('billing_settings_consultation_window_range', sql`${t.consultationWindowDays} BETWEEN 1 AND 365`),
  check('billing_settings_deposit_threshold_range', sql`${t.ipdDepositThresholdPaise} BETWEEN 0 AND 1000000000`),
  check('billing_settings_pharmacy_gst_allowed', sql`${t.pharmacyGstRateBp} IN (0, 500, 1200, 1800, 2800, 4000)`),
])

// One row per configured rule (rule_code from CHARGE_RULE_CODES); a missing row = table defaults.
export const chargeRuleConfigs = pgTable('charge_rule_configs', {
  ruleCode: text('rule_code').primaryKey(),
  enabled: boolean('enabled').default(true).notNull(),
  severity: text('severity', { enum: ['block', 'warn'] }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedByName: text('updated_by_name').notNull(),
})

export const chargeLines = pgTable('charge_lines', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  encounterId: integer('encounter_id').references(() => encounters.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  source: chargeLineSourceEnum('source').notNull(),
  status: chargeLineStatusEnum('status').default('captured').notNull(),
  serviceId: integer('service_id').references(() => serviceCatalog.id),
  itemCode: text('item_code').notNull(),          // snapshot
  itemName: text('item_name').notNull(),          // snapshot
  serviceCategory: serviceCategoryEnum('service_category'),  // snapshot; null for pharmacy
  departmentId: integer('department_id').references(() => departments.id),
  orderingProviderId: integer('ordering_provider_id').references(() => providers.id),
  performingProviderId: integer('performing_provider_id').references(() => providers.id),
  serviceDate: date('service_date').notNull(),    // Asia/Kolkata business date
  quantity: integer('quantity').notNull(),
  unitPricePaise: integer('unit_price_paise').notNull(),
  priceSource: text('price_source', { enum: PRICE_SOURCES }).notNull(),
  tariffRateId: integer('tariff_rate_id').references(() => tariffRates.id),
  resolvedPricePaise: integer('resolved_price_paise'),   // the tariff price an override replaced
  priceOverrideReason: text('price_override_reason'),
  taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
  gstRateBp: integer('gst_rate_bp').notNull(),
  hsnSac: text('hsn_sac').notNull(),
  payerId: integer('payer_id').references(() => payers.id),   // null = self-pay
  preAuthReference: text('pre_auth_reference'),
  procedureCodes: jsonb('procedure_codes').$type<ProcedureCodeRef[]>().default([]).notNull(),
  violations: jsonb('violations').$type<ChargeViolation[]>().default([]).notNull(),
  ruleOverrides: jsonb('rule_overrides').$type<RuleOverride[]>().default([]).notNull(),
  legacyChargeId: integer('legacy_charge_id').references(() => charges.id).unique(),
  medicationDispenseId: integer('medication_dispense_id').references(() => medicationDispenses.id).unique(),
  voidReason: text('void_reason'),
  voidedAt: timestamp('voided_at'),
  voidedByName: text('voided_by_name'),
  createdByName: text('created_by_name').notNull(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Migration B: the draft or issued invoice this line is on (null = unbilled).
  invoiceId: integer('invoice_id').references(() => invoices.id),
  // SP7 (ruling 7): the approved pre-auth a payer line was validated against
  // (scripts/migrations/2026-10-09-sp7-c-preauth-claims.sql).
  preauthId: integer('preauth_id').references(() => preauths.id),
}, (t) => [
  index('charge_lines_patient_idx').on(t.patientId),
  index('charge_lines_encounter_idx').on(t.encounterId),
  index('charge_lines_admission_idx').on(t.admissionId),
  // Room rent is posted idempotently: one live line per admission per census day.
  uniqueIndex('charge_lines_room_rent_day_unique').on(t.admissionId, t.serviceDate).where(sql`source = 'room_rent' AND status <> 'void'`),
  check('charge_lines_quantity_range', sql`${t.quantity} BETWEEN 1 AND 1000`),
  check('charge_lines_unit_price_range', sql`${t.unitPricePaise} BETWEEN 0 AND 1000000000`),
  check('charge_lines_taxable_nonneg', sql`${t.taxablePaise} >= 0`),
  check('charge_lines_gst_rate_allowed', sql`${t.gstRateBp} IN (0, 500, 1200, 1800, 2800, 4000)`),
  check('charge_lines_service_required', sql`${t.source} = 'pharmacy' OR ${t.serviceId} IS NOT NULL`),
  check('charge_lines_context_required', sql`${t.source} = 'pharmacy' OR ${t.encounterId} IS NOT NULL OR ${t.admissionId} IS NOT NULL`),
  check('charge_lines_manual_reason', sql`${t.priceSource} <> 'manual' OR ${t.priceOverrideReason} IS NOT NULL`),
  check('charge_lines_void_reason', sql`${t.status} <> 'void' OR ${t.voidReason} IS NOT NULL`),
  index('charge_lines_invoice_idx').on(t.invoiceId),
])

// Migration B: scripts/migrations/2026-10-08-sp4-b-invoices-ledger.sql (documents and ledger).
// MIGRATION-ONLY IMMUTABILITY: issued documents are guarded by triggers that drizzle cannot
// express and that exist only in migration B (like SP2's tariff_rates_no_overlap):
//   - invoices_issued_guard (sp4_invoice_guard): a finalised or cancelled invoice cannot be
//     deleted, a cancelled one cannot be updated, and a finalised one can only become
//     cancelled (status, cancelled_at, cancelled_by_name; every other column unchanged);
//   - invoice_lines_immutable, credit_notes_immutable, patient_payments_immutable,
//     refunds_immutable (sp4_reject_issued_change): no UPDATE or DELETE at all.
// Each raises SQLSTATE 55000 unless the transaction ran
// `select set_config('hims.allow_document_purge', 'on', true)` (seed clear and test
// fixtures only; never app code). After `db:push` on a fresh DB, apply migration B.
export const documentSeriesEnum = pgEnum('document_series', ['invoice', 'receipt', 'credit_note', 'refund'])
export const invoiceStatusEnum = pgEnum('invoice_status', ['draft', 'finalised', 'cancelled', 'discarded'])
export const paymentModeEnum = pgEnum('payment_mode', ['cash', 'upi', 'card', 'cheque', 'neft', 'other'])
export const patientPaymentKindEnum = pgEnum('patient_payment_kind', ['advance', 'receipt'])

// Gapless numbering: one row per series per financial year (YYYY-YY), incremented with
// UPDATE … RETURNING inside the finalising transaction (Task 10).
export const documentCounters = pgTable('document_counters', {
  series: documentSeriesEnum('series').notNull(),
  financialYear: text('financial_year').notNull(),
  lastValue: integer('last_value').default(0).notNull(),
}, (t) => [
  primaryKey({ name: 'document_counters_pk', columns: [t.series, t.financialYear] }),
  check('document_counters_fy_format', sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
  check('document_counters_value_range', sql`${t.lastValue} BETWEEN 0 AND 999999`),
])

export const invoices = pgTable('invoices', {
  id: serial('id').primaryKey(),
  invoiceNumber: text('invoice_number').unique(),  // drawn at finalisation; drafts have none
  status: invoiceStatusEnum('status').default('draft').notNull(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  encounterId: integer('encounter_id').references(() => encounters.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  payerId: integer('payer_id').references(() => payers.id),
  financialYear: text('financial_year'),
  invoiceDate: date('invoice_date'),               // Asia/Kolkata business date
  documentTitle: text('document_title'),
  supplyType: text('supply_type', { enum: ['intra', 'inter'] }),
  placeOfSupplyStateCode: text('place_of_supply_state_code'),
  snapshot: jsonb('snapshot').$type<InvoiceSnapshot>(),
  taxablePaise: bigint('taxable_paise', { mode: 'number' }),
  cgstPaise: bigint('cgst_paise', { mode: 'number' }),
  sgstPaise: bigint('sgst_paise', { mode: 'number' }),
  igstPaise: bigint('igst_paise', { mode: 'number' }),
  totalPaise: bigint('total_paise', { mode: 'number' }),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  finalisedAt: timestamp('finalised_at'),
  finalisedByName: text('finalised_by_name'),
  cancelledAt: timestamp('cancelled_at'),
  cancelledByName: text('cancelled_by_name'),
  discardedAt: timestamp('discarded_at'),
  discardedByName: text('discarded_by_name'),
}, (t) => [
  check('invoices_number_when_issued', sql`(${t.status} IN ('finalised', 'cancelled')) = (${t.invoiceNumber} IS NOT NULL)`),
  check('invoices_totals_when_issued', sql`${t.status} NOT IN ('finalised', 'cancelled') OR (${t.totalPaise} IS NOT NULL AND ${t.snapshot} IS NOT NULL AND ${t.invoiceDate} IS NOT NULL)`),
  index('invoices_patient_idx').on(t.patientId),
])

// Written only at finalisation, so every row belongs to an issued invoice and is immutable.
export const invoiceLines = pgTable('invoice_lines', {
  id: serial('id').primaryKey(),
  invoiceId: integer('invoice_id').notNull().references(() => invoices.id),
  chargeLineId: integer('charge_line_id').notNull().references(() => chargeLines.id),
  lineNo: integer('line_no').notNull(),
  itemCode: text('item_code').notNull(),
  itemName: text('item_name').notNull(),
  hsnSac: text('hsn_sac').notNull(),
  serviceDate: date('service_date').notNull(),
  quantity: integer('quantity').notNull(),
  unitPricePaise: integer('unit_price_paise').notNull(),
  priceSource: text('price_source', { enum: PRICE_SOURCES }).notNull(),
  taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
  gstRateBp: integer('gst_rate_bp').notNull(),
  cgstRateBp: integer('cgst_rate_bp').notNull(),
  sgstRateBp: integer('sgst_rate_bp').notNull(),
  igstRateBp: integer('igst_rate_bp').notNull(),
  cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull(),
  sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull(),
  igstPaise: bigint('igst_paise', { mode: 'number' }).notNull(),
  totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('invoice_lines_invoice_line_no_unique').on(t.invoiceId, t.lineNo),
])

// Full-value credit note: the only way to cancel a finalised invoice (one per invoice).
export const creditNotes = pgTable('credit_notes', {
  id: serial('id').primaryKey(),
  creditNoteNumber: text('credit_note_number').notNull().unique(),
  invoiceId: integer('invoice_id').notNull().unique().references(() => invoices.id),
  financialYear: text('financial_year').notNull(),
  issueDate: date('issue_date').notNull(),
  reason: text('reason').notNull(),
  taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
  cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull(),
  sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull(),
  igstPaise: bigint('igst_paise', { mode: 'number' }).notNull(),
  totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
  issuedByName: text('issued_by_name').notNull(),
  issuedAt: timestamp('issued_at').defaultNow().notNull(),
})

// Advances and receipts (record-keeping only; no gateway). Both use the RCT series.
export const patientPayments = pgTable('patient_payments', {
  id: serial('id').primaryKey(),
  receiptNumber: text('receipt_number').notNull().unique(),
  kind: patientPaymentKindEnum('kind').notNull(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  encounterId: integer('encounter_id').references(() => encounters.id),
  invoiceId: integer('invoice_id').references(() => invoices.id),
  mode: paymentModeEnum('mode').notNull(),
  reference: text('reference'),                   // never written to the audit log
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  financialYear: text('financial_year').notNull(),
  receiptDate: date('receipt_date').notNull(),
  receivedByName: text('received_by_name').notNull(),
  receivedByUserId: integer('received_by_user_id').references(() => users.id),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
}, (t) => [
  check('patient_payments_amount_positive', sql`${t.amountPaise} > 0`),
  check('patient_payments_reference_required', sql`${t.mode} = 'cash' OR ${t.reference} IS NOT NULL`),
  index('patient_payments_patient_idx').on(t.patientId),
])

export const refunds = pgTable('refunds', {
  id: serial('id').primaryKey(),
  refundNumber: text('refund_number').notNull().unique(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  againstPaymentId: integer('against_payment_id').references(() => patientPayments.id),
  mode: paymentModeEnum('mode').notNull(),
  reference: text('reference'),                   // never written to the audit log
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  reason: text('reason').notNull(),
  financialYear: text('financial_year').notNull(),
  refundDate: date('refund_date').notNull(),
  issuedByName: text('issued_by_name').notNull(),
  issuedAt: timestamp('issued_at').defaultNow().notNull(),
}, (t) => [
  check('refunds_amount_positive', sql`${t.amountPaise} > 0`),
  check('refunds_reference_required', sql`${t.mode} = 'cash' OR ${t.reference} IS NOT NULL`),
  index('refunds_patient_idx').on(t.patientId),
])

export type BillingSettingsRow = typeof billingSettings.$inferSelect
export type ChargeRuleConfigRow = typeof chargeRuleConfigs.$inferSelect
export type ChargeLineRow = typeof chargeLines.$inferSelect
export type InvoiceRow = typeof invoices.$inferSelect
export type InvoiceLineRow = typeof invoiceLines.$inferSelect
export type CreditNoteRow = typeof creditNotes.$inferSelect
export type PatientPaymentRow = typeof patientPayments.$inferSelect
export type RefundRow = typeof refunds.$inferSelect
// end SP4

// SP6 clinical coding (scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql). Enums are
// declared above `diagnoses`, which gains its SP6 columns in place.
// MIGRATION-ONLY: the `pg_trgm` extension and `codes_display_trgm_idx` (GIN over
// lower(display) gin_trgm_ops) exist only in that migration; drizzle cannot express them.
// After `db:push` on a fresh DB, apply the SP6 migrations; text search works without the
// index, only slower. Never `db:push` against a DB that has it (push would drop it).

// One row per imported version of a code set; never deleted or updated in place.
export const codeSystems = pgTable('code_systems', {
  id: serial('id').primaryKey(),
  kind: codeSystemKindEnum('kind').notNull(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  isSample: boolean('is_sample').default(false).notNull(),
  isCurrent: boolean('is_current').default(false).notNull(),
  licenceNote: text('licence_note'),
  sourceFileName: text('source_file_name').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  codeCount: integer('code_count').notNull(),
  importedByName: text('imported_by_name').notNull(),
  importedAt: timestamp('imported_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('code_systems_kind_version_unique').on(t.kind, t.version),
  uniqueIndex('code_systems_one_current_per_kind').on(t.kind).where(sql`${t.isCurrent}`),
  check('code_systems_count_nonneg', sql`${t.codeCount} >= 0`),
  check('code_systems_licence_unless_sample', sql`${t.isSample} OR ${t.licenceNote} IS NOT NULL`),
])

export const codes = pgTable('codes', {
  id: serial('id').primaryKey(),
  codeSystemId: integer('code_system_id').notNull().references(() => codeSystems.id),
  code: text('code').notNull(),
  display: text('display').notNull(),
  parentCode: text('parent_code'),
  selectable: boolean('selectable').default(true).notNull(),
  active: boolean('active').default(true).notNull(),
  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  sexRestriction: text('sex_restriction', { enum: ['male', 'female'] }),
  ageMinYears: integer('age_min_years'),
  ageMaxYears: integer('age_max_years'),
  excludes: text('excludes').array().default(sql`'{}'::text[]`).notNull(),
}, (t) => [
  uniqueIndex('codes_system_code_unique').on(t.codeSystemId, t.code),
  index('codes_code_prefix_idx').on(t.codeSystemId, t.code.op('text_pattern_ops')),
  check('codes_effective_range', sql`${t.effectiveTo} IS NULL OR ${t.effectiveFrom} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`),
  check('codes_age_range', sql`(${t.ageMinYears} IS NULL OR ${t.ageMinYears} BETWEEN 0 AND 150) AND (${t.ageMaxYears} IS NULL OR ${t.ageMaxYears} BETWEEN 0 AND 150) AND (${t.ageMinYears} IS NULL OR ${t.ageMaxYears} IS NULL OR ${t.ageMinYears} <= ${t.ageMaxYears})`),
])

export const encounterProcedures = pgTable('encounter_procedures', {
  id: serial('id').primaryKey(),
  encounterId: integer('encounter_id').notNull().references(() => encounters.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  description: text('description').notNull(),
  codeId: integer('code_id').references(() => codes.id),
  codeSystemKind: codeSystemKindEnum('code_system_kind'),
  code: text('code'),
  codeDisplay: text('code_display'),
  codingStatus: codeEntryStatusEnum('coding_status').default('uncoded').notNull(),
  performedOn: date('performed_on').notNull(),
  performedByProviderId: integer('performed_by_provider_id').references(() => providers.id),
  serviceId: integer('service_id').references(() => serviceCatalog.id),
  sequence: integer('sequence'),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  proposedByName: text('proposed_by_name'),
  proposedAt: timestamp('proposed_at'),
  codedByName: text('coded_by_name'),
  codedAt: timestamp('coded_at'),
  voidedAt: timestamp('voided_at'),
  voidedByName: text('voided_by_name'),
}, (t) => [
  index('encounter_procedures_encounter_id_idx').on(t.encounterId),
  index('encounter_procedures_patient_id_idx').on(t.patientId),
  check('encounter_procedures_code_required', sql`${t.codingStatus} = 'uncoded' OR (${t.codeId} IS NOT NULL AND ${t.code} IS NOT NULL)`),
  check('encounter_procedures_code_kind_pair', sql`(${t.codeId} IS NULL) = (${t.codeSystemKind} IS NULL)`),
])

// The coding status of one encounter; no row = uncoded.
export const encounterCoding = pgTable('encounter_coding', {
  encounterId: integer('encounter_id').primaryKey().references(() => encounters.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  status: encounterCodingStatusEnum('status').default('uncoded').notNull(),
  assignedToUserId: integer('assigned_to_user_id').references(() => users.id),
  assignedToName: text('assigned_to_name'),
  assignedAt: timestamp('assigned_at'),
  codedAt: timestamp('coded_at'),
  codedByName: text('coded_by_name'),
  finalisedAt: timestamp('finalised_at'),
  finalisedByName: text('finalised_by_name'),
  reopenCount: integer('reopen_count').default(0).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('encounter_coding_status_idx').on(t.status),
  index('encounter_coding_assignee_idx').on(t.assignedToUserId),
  check('encounter_coding_finalised_stamp', sql`${t.status} <> 'finalised' OR ${t.finalisedAt} IS NOT NULL`),
])

// Append-only status history; reopen reasons live here, never in the audit log.
export const encounterCodingEvents = pgTable('encounter_coding_events', {
  id: serial('id').primaryKey(),
  encounterId: integer('encounter_id').notNull().references(() => encounters.id),
  action: codingEventActionEnum('action').notNull(),
  fromStatus: encounterCodingStatusEnum('from_status').notNull(),
  toStatus: encounterCodingStatusEnum('to_status').notNull(),
  reason: text('reason'),
  byName: text('by_name').notNull(),
  byUserId: integer('by_user_id').references(() => users.id),
  at: timestamp('at').defaultNow().notNull(),
}, (t) => [
  index('encounter_coding_events_encounter_idx').on(t.encounterId),
  index('encounter_coding_events_at_idx').on(t.at),
  check('encounter_coding_events_reason_len', sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 500`),
])

export const codingQueries = pgTable('coding_queries', {
  id: serial('id').primaryKey(),
  encounterId: integer('encounter_id').notNull().references(() => encounters.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  addressedToProviderId: integer('addressed_to_provider_id').notNull().references(() => providers.id),
  question: text('question').notNull(),
  status: codingQueryStatusEnum('status').default('open').notNull(),
  raisedByName: text('raised_by_name').notNull(),
  raisedByUserId: integer('raised_by_user_id').references(() => users.id),
  raisedAt: timestamp('raised_at').defaultNow().notNull(),
  answeredAt: timestamp('answered_at'),
  closedAt: timestamp('closed_at'),
  closedByName: text('closed_by_name'),
}, (t) => [
  index('coding_queries_encounter_idx').on(t.encounterId),
  index('coding_queries_provider_status_idx').on(t.addressedToProviderId, t.status),
  check('coding_queries_question_len', sql`char_length(${t.question}) BETWEEN 1 AND 1000`),
])

export const codingQueryResponses = pgTable('coding_query_responses', {
  id: serial('id').primaryKey(),
  queryId: integer('query_id').notNull(),
  authorName: text('author_name').notNull(),
  authorRole: roleEnum('author_role').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({ name: 'coding_query_responses_query_fk', columns: [t.queryId], foreignColumns: [codingQueries.id] }).onDelete('cascade'),
  index('coding_query_responses_query_idx').on(t.queryId),
  check('coding_query_responses_body_len', sql`char_length(${t.body}) BETWEEN 1 AND 2000`),
])

// Service catalogue <-> procedure/package code map; version-independent (kind + code value).
export const serviceProcedureCodes = pgTable('service_procedure_codes', {
  id: serial('id').primaryKey(),
  serviceId: integer('service_id').notNull().references(() => serviceCatalog.id),
  codeSystemKind: codeSystemKindEnum('code_system_kind').notNull(),
  code: text('code').notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('service_procedure_codes_unique').on(t.serviceId, t.codeSystemKind, t.code),
  uniqueIndex('service_procedure_codes_one_primary').on(t.serviceId).where(sql`${t.isPrimary}`),
])

export type DiagnosisRow = typeof diagnoses.$inferSelect
export type CodeSystemRow = typeof codeSystems.$inferSelect
export type CodeRow = typeof codes.$inferSelect
export type EncounterProcedureRow = typeof encounterProcedures.$inferSelect
export type EncounterCodingRow = typeof encounterCoding.$inferSelect
export type EncounterCodingEventRow = typeof encounterCodingEvents.$inferSelect
export type CodingQueryRow = typeof codingQueries.$inferSelect
export type CodingQueryResponseRow = typeof codingQueryResponses.$inferSelect
export type ServiceProcedureCodeRow = typeof serviceProcedureCodes.$inferSelect
// end SP6

// SP7 RCM, insurer/TPA and claims. Migration B: scripts/migrations/2026-10-09-sp7-b-payers-policies.sql
// (payer profiles, networks, contacts, document requirements, reason codes, patient policies).
// A payer becomes an insurer, TPA, government scheme or corporate through a 1:1 profile row;
// payers.payer_type (the US enum) is ignored by SP7 (ruling 6). Money is bigint paise.
export const payerKindEnum = pgEnum('payer_kind', ['insurer', 'tpa', 'government_scheme', 'corporate'])
export const submissionChannelEnum = pgEnum('claim_submission_channel', ['portal', 'email', 'nhcx', 'courier', 'hand_delivery'])
export const empanelmentStatusEnum = pgEnum('empanelment_status', ['empanelled', 'pending', 'suspended', 'not_empanelled'])
export const policyTypeEnum = pgEnum('policy_type', ['individual', 'family_floater', 'group_corporate', 'government_scheme'])
export const policyRelationshipEnum = pgEnum('policy_relationship', ['self', 'spouse', 'child', 'parent', 'sibling', 'other'])
export const policyPriorityEnum = pgEnum('policy_priority', ['primary', 'secondary'])
export const policyStatusEnum = pgEnum('policy_status', ['active', 'inactive'])
export const claimTypeEnum = pgEnum('claim_type', ['ipd', 'daycare', 'opd'])
export const claimDocumentKindEnum = pgEnum('claim_document_kind', [
  'id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports',
  'preauth_approval', 'operation_notes', 'prescription', 'query_response', 'appeal_letter', 'settlement_advice', 'other',
])
export const rcmReasonCategoryEnum = pgEnum('rcm_reason_category', ['disallowance', 'rejection', 'query', 'write_off'])

export const payerProfiles = pgTable('payer_profiles', {
  payerId: integer('payer_id').primaryKey().references(() => payers.id),
  kind: payerKindEnum('kind').notNull(),
  shortName: text('short_name'),
  irdaiRegistrationNo: text('irdai_registration_no'),
  nhcxParticipantCode: text('nhcx_participant_code'),
  defaultChannel: submissionChannelEnum('default_channel').default('portal').notNull(),
  portalUrl: text('portal_url'),
  claimsEmail: text('claims_email'),
  empanelmentStatus: empanelmentStatusEnum('empanelment_status').default('pending').notNull(),
  empanelledFrom: date('empanelled_from'),
  empanelledTo: date('empanelled_to'),
  agreementReference: text('agreement_reference'),
  preauthSlaHours: integer('preauth_sla_hours').default(1).notNull(),
  claimSettlementSlaDays: integer('claim_settlement_sla_days').default(30).notNull(),
  queryResponseDays: integer('query_response_days').default(7).notNull(),
  submissionWindowDays: integer('submission_window_days').default(15).notNull(),
  requiresAbha: boolean('requires_abha').default(false).notNull(),
  requiresPreauthForIpd: boolean('requires_preauth_for_ipd').default(true).notNull(),
  active: boolean('active').default(true).notNull(),
  notes: text('notes'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedByName: text('updated_by_name').notNull(),
}, (t) => [
  check('payer_profiles_sla_ranges', sql`${t.preauthSlaHours} BETWEEN 1 AND 720 AND ${t.claimSettlementSlaDays} BETWEEN 1 AND 365 AND ${t.queryResponseDays} BETWEEN 1 AND 90 AND ${t.submissionWindowDays} BETWEEN 1 AND 365`),
  check('payer_profiles_empanelment_dates', sql`${t.empanelledTo} IS NULL OR ${t.empanelledFrom} IS NULL OR ${t.empanelledTo} >= ${t.empanelledFrom}`),
])

// Which TPAs service which insurer.
export const payerNetworks = pgTable('payer_networks', {
  id: serial('id').primaryKey(),
  insurerPayerId: integer('insurer_payer_id').notNull().references(() => payers.id),
  tpaPayerId: integer('tpa_payer_id').notNull().references(() => payers.id),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('payer_networks_pair_unique').on(t.insurerPayerId, t.tpaPayerId),
])

export const payerContacts = pgTable('payer_contacts', {
  id: serial('id').primaryKey(),
  payerId: integer('payer_id').notNull().references(() => payers.id),
  name: text('name').notNull(),
  designation: text('designation'),
  phone: text('phone'),
  email: text('email'),
  isEscalation: boolean('is_escalation').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('payer_contacts_payer_idx').on(t.payerId),
])

// Per-payer overrides of DEFAULT_REQUIRED_DOCUMENTS (src/lib/rcm/readiness.ts).
export const payerDocumentRequirements = pgTable('payer_document_requirements', {
  id: serial('id').primaryKey(),
  payerId: integer('payer_id').notNull().references(() => payers.id),
  claimType: claimTypeEnum('claim_type').notNull(),
  documentKind: claimDocumentKindEnum('document_kind').notNull(),
  required: boolean('required').notNull(),
  updatedByName: text('updated_by_name').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('payer_document_requirements_unique').on(t.payerId, t.claimType, t.documentKind),
])

// Reference data, seeded by migration B; never cleared by the seed.
export const rcmReasonCodes = pgTable('rcm_reason_codes', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  category: rcmReasonCategoryEnum('category').notNull(),
  patientRecoverableDefault: boolean('patient_recoverable_default').notNull(),
  active: boolean('active').default(true).notNull(),
  sortOrder: integer('sort_order').notNull(),
}, (t) => [
  check('rcm_reason_codes_code_format', sql`${t.code} ~ '^[A-Z0-9_]{2,16}$'`),
])

// A patient's insurance policy / card. Card images live in the private blob store; the URL
// never leaves the server. One active primary per patient (partial unique index).
export const patientPolicies = pgTable('patient_policies', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  insurerPayerId: integer('insurer_payer_id').notNull().references(() => payers.id),
  tpaPayerId: integer('tpa_payer_id').references(() => payers.id),
  policyNumber: text('policy_number').notNull(),
  memberId: text('member_id').notNull(),
  planName: text('plan_name'),
  policyType: policyTypeEnum('policy_type').notNull(),
  corporateName: text('corporate_name'),
  employeeId: text('employee_id'),
  holderName: text('holder_name').notNull(),
  relationship: policyRelationshipEnum('relationship').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to').notNull(),
  sumInsuredPaise: bigint('sum_insured_paise', { mode: 'number' }),
  copayBp: integer('copay_bp'),
  roomRentLimitPaise: bigint('room_rent_limit_paise', { mode: 'number' }),
  priority: policyPriorityEnum('priority').default('primary').notNull(),
  status: policyStatusEnum('status').default('active').notNull(),
  cardFrontBlobUrl: text('card_front_blob_url'),
  cardFrontSha256: text('card_front_sha256'),
  cardBackBlobUrl: text('card_back_blob_url'),
  cardBackSha256: text('card_back_sha256'),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedByName: text('updated_by_name'),
}, (t) => [
  index('patient_policies_patient_idx').on(t.patientId),
  uniqueIndex('patient_policies_one_active_primary').on(t.patientId).where(sql`status = 'active' AND priority = 'primary'`),
  check('patient_policies_dates', sql`${t.validTo} >= ${t.validFrom}`),
  check('patient_policies_amounts', sql`(${t.sumInsuredPaise} IS NULL OR ${t.sumInsuredPaise} BETWEEN 0 AND 1000000000000) AND (${t.roomRentLimitPaise} IS NULL OR ${t.roomRentLimitPaise} BETWEEN 0 AND 1000000000000) AND (${t.copayBp} IS NULL OR ${t.copayBp} BETWEEN 0 AND 10000)`),
  check('patient_policies_card_pairs', sql`(${t.cardFrontBlobUrl} IS NULL) = (${t.cardFrontSha256} IS NULL) AND (${t.cardBackBlobUrl} IS NULL) = (${t.cardBackSha256} IS NULL)`),
])

export type PayerProfileRow = typeof payerProfiles.$inferSelect
export type PayerNetworkRow = typeof payerNetworks.$inferSelect
export type PayerContactRow = typeof payerContacts.$inferSelect
export type PayerDocumentRequirementRow = typeof payerDocumentRequirements.$inferSelect
export type RcmReasonCodeRow = typeof rcmReasonCodes.$inferSelect
export type PatientPolicyRow = typeof patientPolicies.$inferSelect
// end SP7 migration B

// SP7 migration C: scripts/migrations/2026-10-09-sp7-c-preauth-claims.sql (pre-auths, queries,
// claims, invoice links, submission versions, dispatches, events, documents, disallowances,
// settlements, write-offs). Pre-auth and claim numbers come from Postgres sequences (ruling 8).
// MIGRATION-ONLY IMMUTABILITY (like SP4's issued-document triggers; drizzle cannot express them):
//   - claim_submissions, claim_events, claim_disallowances, preauth_events, preauth_documents:
//     no UPDATE or DELETE at all (sp7_append_only);
//   - claim_dispatches: no DELETE; an UPDATE only while insurer_reference is null and only of
//     insurer_reference / acknowledged_on / acknowledged_by_name (sp7_dispatch_guard);
//   - claim_settlements: no DELETE; an UPDATE only while reconciled_at is null and only of
//     bank_credit_date / reconciled_at / reconciled_by_name (sp7_settlement_guard);
//   - claim_write_offs: no DELETE; an UPDATE only while status = 'requested' and only of the
//     decision columns (sp7_write_off_guard).
// Each raises SQLSTATE 55000 unless the transaction ran
// `select set_config('hims.allow_document_purge', 'on', true)` (seed clear, deletePatient's
// purge of a deletable patient's drafts, and test fixtures only).
export const preauthStatusEnum = pgEnum('preauth_status', [
  'draft', 'requested', 'queried', 'approved', 'enhancement_requested', 'enhancement_queried', 'enhanced', 'rejected', 'cancelled',
])
export const preauthActionEnum = pgEnum('preauth_action', [
  'request', 'record_query', 'respond_query', 'approve', 'reject', 'request_enhancement', 'approve_enhancement', 'reject_enhancement', 'cancel',
])
export const claimStatusEnum = pgEnum('claim_status', [
  'draft', 'submitted', 'queried', 'approved', 'partially_approved', 'rejected', 'appealed', 'settled', 'closed', 'withdrawn',
])
export const claimEventActionEnum = pgEnum('claim_event_action', [
  'submit', 'record_query', 'respond_query', 'record_approval', 'record_partial_approval', 'record_rejection',
  'appeal', 'record_settlement', 'close', 'reopen', 'withdraw', 'note',
])
export const submissionKindEnum = pgEnum('claim_submission_kind', ['initial', 'query_response', 'appeal', 'resubmission'])
export const rcmQueryStatusEnum = pgEnum('rcm_query_status', ['open', 'answered', 'closed'])
export const writeOffStatusEnum = pgEnum('claim_write_off_status', ['requested', 'approved', 'rejected'])
export const documentSourceEnum = pgEnum('claim_document_source', ['upload', 'invoice', 'lab_report', 'discharge_summary', 'preauth_letter', 'policy_card', 'waiver'])
export const ID_PROOF_TYPE_VALUES = ['pan', 'voter_id', 'passport', 'driving_licence', 'masked_uid', 'other_government_id'] as const

export const preauthNumberSeq = pgSequence('preauth_number_seq')
export const claimNumberSeq = pgSequence('claim_number_seq')

export const preauths = pgTable('preauths', {
  id: serial('id').primaryKey(),
  preauthNumber: text('preauth_number').notNull().unique(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  policyId: integer('policy_id').notNull().references(() => patientPolicies.id),
  insurerPayerId: integer('insurer_payer_id').notNull().references(() => payers.id),
  tpaPayerId: integer('tpa_payer_id').references(() => payers.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  encounterId: integer('encounter_id').references(() => encounters.id),
  claimType: claimTypeEnum('claim_type').notNull(),
  status: preauthStatusEnum('status').default('draft').notNull(),
  plannedAdmissionDate: date('planned_admission_date').notNull(),
  expectedLengthOfStayDays: integer('expected_length_of_stay_days').notNull(),
  roomCategoryCode: text('room_category_code'),
  treatingProviderId: integer('treating_provider_id').notNull().references(() => providers.id),
  diagnoses: jsonb('diagnoses').$type<CodedEntry[]>().default([]).notNull(),
  procedures: jsonb('procedures').$type<CodedEntry[]>().default([]).notNull(),
  provisionalDiagnosisText: text('provisional_diagnosis_text'),
  estimateLines: jsonb('estimate_lines').$type<EstimateLine[]>().notNull(),
  estimatedPaise: bigint('estimated_paise', { mode: 'number' }).notNull(),
  requestedPaise: bigint('requested_paise', { mode: 'number' }).notNull(),
  approvedPaise: bigint('approved_paise', { mode: 'number' }),
  approvalReference: text('approval_reference'),
  validUntil: date('valid_until'),
  firstRequestedAt: timestamp('first_requested_at'),
  lastRequestedAt: timestamp('last_requested_at'),
  decidedAt: timestamp('decided_at'),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('preauths_patient_idx').on(t.patientId),
  index('preauths_status_idx').on(t.status),
  uniqueIndex('preauths_insurer_reference_unique').on(t.insurerPayerId, sql`lower(approval_reference)`).where(sql`approval_reference IS NOT NULL`),
  check('preauths_approved_fields', sql`${t.status} NOT IN ('approved', 'enhancement_requested', 'enhancement_queried', 'enhanced') OR (${t.approvedPaise} IS NOT NULL AND ${t.approvalReference} IS NOT NULL AND ${t.validUntil} IS NOT NULL)`),
  check('preauths_amounts_range', sql`${t.estimatedPaise} BETWEEN 0 AND 1000000000000 AND ${t.requestedPaise} BETWEEN 0 AND 1000000000000 AND (${t.approvedPaise} IS NULL OR ${t.approvedPaise} BETWEEN 0 AND 1000000000000) AND ${t.expectedLengthOfStayDays} BETWEEN 1 AND 365`),
])

export const preauthEvents = pgTable('preauth_events', {
  id: serial('id').primaryKey(),
  preauthId: integer('preauth_id').notNull().references(() => preauths.id),
  action: preauthActionEnum('action').notNull(),
  fromStatus: preauthStatusEnum('from_status'),
  toStatus: preauthStatusEnum('to_status').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }),
  reasonCode: text('reason_code').references(() => rcmReasonCodes.code),
  note: text('note'),
  snapshot: jsonb('snapshot').$type<PreauthSnapshot>(),
  snapshotSha256: text('snapshot_sha256'),
  byName: text('by_name').notNull(),
  byUserId: integer('by_user_id').references(() => users.id),
  at: timestamp('at').defaultNow().notNull(),
}, (t) => [
  index('preauth_events_preauth_idx').on(t.preauthId),
  check('preauth_events_note_len', sql`${t.note} IS NULL OR length(${t.note}) <= 1000`),
  check('preauth_events_snapshot_pair', sql`(${t.snapshot} IS NULL) = (${t.snapshotSha256} IS NULL)`),
])

// An insurer query on a pre-auth or a claim (exactly one subject).
export const rcmQueries = pgTable('rcm_queries', {
  id: serial('id').primaryKey(),
  preauthId: integer('preauth_id').references(() => preauths.id),
  claimId: integer('claim_id').references(() => claims.id),
  question: text('question').notNull(),
  raisedOn: date('raised_on').notNull(),
  dueOn: date('due_on').notNull(),
  status: rcmQueryStatusEnum('status').default('open').notNull(),
  answeredAt: timestamp('answered_at'),
  closedAt: timestamp('closed_at'),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('rcm_queries_claim_idx').on(t.claimId),
  index('rcm_queries_preauth_idx').on(t.preauthId),
  check('rcm_queries_one_subject', sql`(${t.preauthId} IS NULL) <> (${t.claimId} IS NULL)`),
  check('rcm_queries_due_after_raised', sql`${t.dueOn} >= ${t.raisedOn}`),
  check('rcm_queries_question_len', sql`length(${t.question}) BETWEEN 1 AND 2000`),
])

export const rcmQueryResponses = pgTable('rcm_query_responses', {
  id: serial('id').primaryKey(),
  queryId: integer('query_id').notNull(),
  body: text('body').notNull(),
  respondedOn: date('responded_on').notNull(),
  submissionId: integer('submission_id').references(() => claimSubmissions.id),
  byName: text('by_name').notNull(),
  at: timestamp('at').defaultNow().notNull(),
}, (t) => [
  foreignKey({ name: 'rcm_query_responses_query_fk', columns: [t.queryId], foreignColumns: [rcmQueries.id] }),
  index('rcm_query_responses_query_idx').on(t.queryId),
])

export const preauthDocuments = pgTable('preauth_documents', {
  id: serial('id').primaryKey(),
  preauthId: integer('preauth_id').notNull().references(() => preauths.id),
  kind: claimDocumentKindEnum('kind').notNull(),
  title: text('title').notNull(),
  blobUrl: text('blob_url').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  queryResponseId: integer('query_response_id').references(() => rcmQueryResponses.id),
  uploadedByName: text('uploaded_by_name').notNull(),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
}, (t) => [
  index('preauth_documents_preauth_idx').on(t.preauthId),
])

export const claims = pgTable('claims', {
  id: serial('id').primaryKey(),
  claimNumber: text('claim_number').notNull().unique(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  policyId: integer('policy_id').notNull().references(() => patientPolicies.id),
  insurerPayerId: integer('insurer_payer_id').notNull().references(() => payers.id),
  tpaPayerId: integer('tpa_payer_id').references(() => payers.id),
  billingPayerId: integer('billing_payer_id').notNull().references(() => payers.id),
  claimType: claimTypeEnum('claim_type').notNull(),
  admissionId: integer('admission_id').references(() => admissions.id),
  encounterId: integer('encounter_id').references(() => encounters.id),
  preauthId: integer('preauth_id').references(() => preauths.id),
  status: claimStatusEnum('status').default('draft').notNull(),
  claimedPaise: bigint('claimed_paise', { mode: 'number' }).default(0).notNull(),
  approvedPaise: bigint('approved_paise', { mode: 'number' }),
  disallowedPaise: bigint('disallowed_paise', { mode: 'number' }).default(0).notNull(),
  nonRecoverableDisallowedPaise: bigint('non_recoverable_disallowed_paise', { mode: 'number' }).default(0).notNull(),
  settledPaise: bigint('settled_paise', { mode: 'number' }).default(0).notNull(),
  writtenOffPaise: bigint('written_off_paise', { mode: 'number' }).default(0).notNull(),
  currentDecisionEventId: integer('current_decision_event_id'), // no FK: avoids a claims <-> claim_events cycle
  currentVersion: integer('current_version').default(0).notNull(),
  rowVersion: integer('row_version').default(0).notNull(),
  insurerClaimReference: text('insurer_claim_reference'),
  firstSubmittedAt: timestamp('first_submitted_at'),
  lastStatusAt: timestamp('last_status_at'),
  closedAt: timestamp('closed_at'),
  createdByName: text('created_by_name').notNull(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('claims_patient_idx').on(t.patientId),
  index('claims_status_idx').on(t.status),
  index('claims_billing_payer_idx').on(t.billingPayerId),
  check('claims_context', sql`(${t.claimType} = 'opd' AND ${t.encounterId} IS NOT NULL AND ${t.admissionId} IS NULL) OR (${t.claimType} IN ('ipd', 'daycare') AND ${t.admissionId} IS NOT NULL)`),
  check('claims_amounts_nonneg', sql`${t.claimedPaise} BETWEEN 0 AND 1000000000000 AND (${t.approvedPaise} IS NULL OR ${t.approvedPaise} >= 0) AND ${t.disallowedPaise} >= 0 AND ${t.nonRecoverableDisallowedPaise} >= 0 AND ${t.settledPaise} >= 0 AND ${t.writtenOffPaise} >= 0`),
  check('claims_approved_le_claimed', sql`${t.approvedPaise} IS NULL OR ${t.approvedPaise} <= ${t.claimedPaise}`),
  check('claims_credits_le_claimed', sql`${t.settledPaise} + ${t.writtenOffPaise} <= ${t.claimedPaise}`),
  check('claims_nonrecoverable_le_disallowed', sql`${t.nonRecoverableDisallowedPaise} <= ${t.disallowedPaise}`),
])

// The invoices a claim covers. invoice_total_paise is the invoice total at link time; one
// invoice may sit on several claims as long as the claimed amounts never exceed its total
// (enforced under the per-patient billing lock, ruling 2).
export const claimInvoices = pgTable('claim_invoices', {
  claimId: integer('claim_id').notNull().references(() => claims.id),
  invoiceId: integer('invoice_id').notNull().references(() => invoices.id),
  invoiceTotalPaise: bigint('invoice_total_paise', { mode: 'number' }).notNull(),
  claimedPaise: bigint('claimed_paise', { mode: 'number' }).notNull(),
  addedByName: text('added_by_name').notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ name: 'claim_invoices_pk', columns: [t.claimId, t.invoiceId] }),
  index('claim_invoices_invoice_idx').on(t.invoiceId),
  check('claim_invoices_claimed_range', sql`${t.claimedPaise} BETWEEN 1 AND ${t.invoiceTotalPaise}`),
])

// One row per outbound package (ruling 3): the canonical snapshot, its SHA-256 and both copies.
export const claimSubmissions = pgTable('claim_submissions', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => claims.id),
  version: integer('version').notNull(),
  kind: submissionKindEnum('kind').notNull(),
  snapshot: jsonb('snapshot').$type<ClaimSnapshot>().notNull(),
  snapshotSha256: text('snapshot_sha256').notNull(),
  rcmCopyBlobUrl: text('rcm_copy_blob_url').notNull(),
  rcmCopySha256: text('rcm_copy_sha256').notNull(),
  insurerCopyBlobUrl: text('insurer_copy_blob_url').notNull(),
  insurerCopySha256: text('insurer_copy_sha256').notNull(),
  createdByName: text('created_by_name').notNull(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('claim_submissions_claim_version_unique').on(t.claimId, t.version),
])

export const claimDispatches = pgTable('claim_dispatches', {
  id: serial('id').primaryKey(),
  submissionId: integer('submission_id').notNull().unique().references(() => claimSubmissions.id),
  channel: submissionChannelEnum('channel').notNull(),
  transport: text('transport', { enum: ['manual', 'nhcx'] }).notNull(),
  trackingReference: text('tracking_reference'),
  dispatchedOn: date('dispatched_on').notNull(),
  dispatchedByName: text('dispatched_by_name').notNull(),
  dispatchedAt: timestamp('dispatched_at').defaultNow().notNull(),
  insurerReference: text('insurer_reference'),
  acknowledgedOn: date('acknowledged_on'),
  acknowledgedByName: text('acknowledged_by_name'),
})

export const claimEvents = pgTable('claim_events', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => claims.id),
  action: claimEventActionEnum('action').notNull(),
  fromStatus: claimStatusEnum('from_status'),
  toStatus: claimStatusEnum('to_status').notNull(),
  submissionId: integer('submission_id').references(() => claimSubmissions.id),
  amountPaise: bigint('amount_paise', { mode: 'number' }),
  note: text('note'),
  portalCheckedOn: date('portal_checked_on'),
  byName: text('by_name').notNull(),
  byUserId: integer('by_user_id').references(() => users.id),
  at: timestamp('at').defaultNow().notNull(),
}, (t) => [
  index('claim_events_claim_idx').on(t.claimId),
  check('claim_events_note_len', sql`${t.note} IS NULL OR length(${t.note}) <= 2000`),
])

// Rows are never deleted: removal sets superseded_at, so earlier snapshots keep their hashes.
// source_id points at the source row of a system document (invoice, pre-auth document,
// lab report, ...) and deliberately has no FK (the source table depends on `source`).
export const claimDocuments = pgTable('claim_documents', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => claims.id),
  kind: claimDocumentKindEnum('kind').notNull(),
  source: documentSourceEnum('source').notNull(),
  title: text('title').notNull(),
  blobUrl: text('blob_url'),
  contentType: text('content_type'),
  byteSize: integer('byte_size'),
  sha256: text('sha256'),
  sourceId: integer('source_id'),
  idProofType: text('id_proof_type', { enum: ID_PROOF_TYPE_VALUES }),
  waiverReason: text('waiver_reason'),
  queryResponseId: integer('query_response_id').references(() => rcmQueryResponses.id),
  supersededAt: timestamp('superseded_at'),
  supersededByName: text('superseded_by_name'),
  uploadedByName: text('uploaded_by_name').notNull(),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
}, (t) => [
  index('claim_documents_claim_idx').on(t.claimId),
  check('claim_documents_upload_complete', sql`${t.source} <> 'upload' OR (${t.blobUrl} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.contentType} IS NOT NULL)`),
  check('claim_documents_waiver_reason', sql`${t.source} <> 'waiver' OR ${t.waiverReason} IS NOT NULL`),
  check('claim_documents_id_proof_type', sql`${t.kind} <> 'id_proof' OR ${t.source} <> 'upload' OR ${t.idProofType} IS NOT NULL`),
])

export const claimDisallowances = pgTable('claim_disallowances', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => claims.id),
  eventId: integer('event_id').notNull().references(() => claimEvents.id),
  reasonCode: text('reason_code').notNull().references(() => rcmReasonCodes.code),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  patientRecoverable: boolean('patient_recoverable').notNull(),
  note: text('note'),
}, (t) => [
  index('claim_disallowances_claim_idx').on(t.claimId),
  check('claim_disallowances_amount_positive', sql`${t.amountPaise} > 0`),
])

export const claimSettlements = pgTable('claim_settlements', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => claims.id),
  eventId: integer('event_id').notNull().references(() => claimEvents.id),
  utr: text('utr').notNull(),
  paymentDate: date('payment_date').notNull(),
  receivedPaise: bigint('received_paise', { mode: 'number' }).notNull(),
  tdsPaise: bigint('tds_paise', { mode: 'number' }).notNull(),
  bankChargesPaise: bigint('bank_charges_paise', { mode: 'number' }).notNull(),
  settledPaise: bigint('settled_paise', { mode: 'number' }).notNull(),
  bankCreditDate: date('bank_credit_date'),
  reconciledAt: timestamp('reconciled_at'),
  reconciledByName: text('reconciled_by_name'),
  recordedByName: text('recorded_by_name').notNull(),
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('claim_settlements_claim_utr_unique').on(t.claimId, sql`lower(utr)`),
  check('claim_settlements_sum', sql`${t.settledPaise} = ${t.receivedPaise} + ${t.tdsPaise} + ${t.bankChargesPaise}`),
  check('claim_settlements_amounts', sql`${t.receivedPaise} > 0 AND ${t.tdsPaise} >= 0 AND ${t.bankChargesPaise} >= 0`),
])

export const claimWriteOffs = pgTable('claim_write_offs', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => claims.id),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  reasonCode: text('reason_code').notNull().references(() => rcmReasonCodes.code),
  note: text('note').notNull(),
  status: writeOffStatusEnum('status').default('requested').notNull(),
  requestedByName: text('requested_by_name').notNull(),
  requestedByUserId: integer('requested_by_user_id').references(() => users.id),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  decidedByName: text('decided_by_name'),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at'),
  decisionNote: text('decision_note'),
}, (t) => [
  index('claim_write_offs_claim_idx').on(t.claimId),
  check('claim_write_offs_amount_positive', sql`${t.amountPaise} > 0`),
  check('claim_write_offs_decided', sql`${t.status} = 'requested' OR (${t.decidedAt} IS NOT NULL AND ${t.decidedByName} IS NOT NULL)`),
  check('claim_write_offs_second_person', sql`${t.decidedByUserId} IS NULL OR ${t.decidedByUserId} IS DISTINCT FROM ${t.requestedByUserId}`),
])

export type PreauthRow = typeof preauths.$inferSelect
export type PreauthEventRow = typeof preauthEvents.$inferSelect
export type RcmQueryRow = typeof rcmQueries.$inferSelect
export type RcmQueryResponseRow = typeof rcmQueryResponses.$inferSelect
export type PreauthDocumentRow = typeof preauthDocuments.$inferSelect
export type ClaimRow = typeof claims.$inferSelect
export type ClaimInvoiceRow = typeof claimInvoices.$inferSelect
export type ClaimSubmissionRow = typeof claimSubmissions.$inferSelect
export type ClaimDispatchRow = typeof claimDispatches.$inferSelect
export type ClaimEventRow = typeof claimEvents.$inferSelect
export type ClaimDocumentRow = typeof claimDocuments.$inferSelect
export type ClaimDisallowanceRow = typeof claimDisallowances.$inferSelect
export type ClaimSettlementRow = typeof claimSettlements.$inferSelect
export type ClaimWriteOffRow = typeof claimWriteOffs.$inferSelect
// end SP7

// SP8 ABDM / NHCX integration (scripts/migrations/2026-10-10-sp8-abdm-nhcx.sql).
// Migration-only objects: the append-only triggers on abdm_consents (the one allowed update
// sets patient_id from NULL) and nhcx_inbound_calls, both bypassed only under the
// transaction-local hims.allow_document_purge = 'on'. Aadhaar numbers, OTPs and ABDM tokens are
// never stored in any of these tables (SP8 ruling 4).
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Consent captured before an ABHA is created or verified (S1 CRT_ABHA_102). patient_id may be
// null: consent can be given before the patient is registered.
export const abdmConsents = pgTable('abdm_consents', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id'),
  flowId: text('flow_id').notNull(),
  purpose: text('purpose', { enum: ABDM_CONSENT_PURPOSES }).notNull(),
  consentCode: text('consent_code').notNull(),
  consentVersion: text('consent_version').notNull(),
  textSha256: text('text_sha256').notNull(),
  givenBy: text('given_by', { enum: ABDM_CONSENT_GIVEN_BY }).notNull(),
  recordedByName: text('recorded_by_name').notNull(),
  recordedByUserId: integer('recorded_by_user_id'),
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({ name: 'abdm_consents_patient_fk', columns: [t.patientId], foreignColumns: [patients.id] }),
  foreignKey({ name: 'abdm_consents_recorded_by_user_fk', columns: [t.recordedByUserId], foreignColumns: [users.id] }),
  index('abdm_consents_patient_idx').on(t.patientId),
  index('abdm_consents_flow_idx').on(t.flowId),
  check('abdm_consents_purpose_valid', sql`${t.purpose} IN (${inList(ABDM_CONSENT_PURPOSES)})`),
  check('abdm_consents_given_by_valid', sql`${t.givenBy} IN (${inList(ABDM_CONSENT_GIVEN_BY)})`),
])

// Scan & Share profile shares (S1 hiecm-scan-and-register.yaml). Unresolved rows are scrubbed
// after 24 hours (status 'expired' with every profile column null).
export const abdmProfileShares = pgTable('abdm_profile_shares', {
  id: serial('id').primaryKey(),
  requestId: text('request_id').notNull(),
  hipId: text('hip_id').notNull(),
  counterId: text('counter_id').notNull(),
  intent: text('intent').notNull(),
  abhaNumber: text('abha_number'),
  abhaAddress: text('abha_address'),
  name: text('name'),
  gender: text('gender'),
  yearOfBirth: integer('year_of_birth'),
  monthOfBirth: integer('month_of_birth'),
  dayOfBirth: integer('day_of_birth'),
  phone: text('phone'),
  addressLine: text('address_line'),
  districtName: text('district_name'),
  stateName: text('state_name'),
  pincode: text('pincode'),
  tokenDate: date('token_date').notNull(),
  tokenNumber: integer('token_number').notNull(),
  status: text('status', { enum: PROFILE_SHARE_STATUSES }).default('pending').notNull(),
  patientId: text('patient_id'),
  ackState: text('ack_state', { enum: PROFILE_SHARE_ACK_STATES }).default('pending').notNull(),
  isMock: boolean('is_mock').default(false).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
  resolvedByName: text('resolved_by_name'),
}, (t) => [
  unique('abdm_profile_shares_request_unique').on(t.requestId),
  foreignKey({ name: 'abdm_profile_shares_patient_fk', columns: [t.patientId], foreignColumns: [patients.id] }),
  uniqueIndex('abdm_profile_shares_token_unique').on(t.tokenDate, t.counterId, t.tokenNumber),
  index('abdm_profile_shares_status_idx').on(t.status, t.receivedAt),
  check('abdm_profile_shares_expired_scrubbed', sql`${t.status} <> 'expired' OR (${t.abhaNumber} IS NULL AND ${t.abhaAddress} IS NULL AND ${t.name} IS NULL AND ${t.phone} IS NULL AND ${t.addressLine} IS NULL)`),
  check('abdm_profile_shares_status_valid', sql`${t.status} IN (${inList(PROFILE_SHARE_STATUSES)})`),
  check('abdm_profile_shares_ack_state_valid', sql`${t.ackState} IN (${inList(PROFILE_SHARE_ACK_STATES)})`),
  check('abdm_profile_shares_token_positive', sql`${t.tokenNumber} > 0`),
])

// NHCX CoverageEligibilityRequest checks (replacing the simulated eligibility check).
export const nhcxEligibilityChecks = pgTable('nhcx_eligibility_checks', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull(),
  policyId: integer('policy_id').notNull(),
  payerId: integer('payer_id').notNull(),
  purpose: text('purpose', { enum: ELIGIBILITY_PURPOSES }).notNull(),
  context: text('context', { enum: ELIGIBILITY_CONTEXTS }).notNull(),
  status: text('status', { enum: ELIGIBILITY_STATUSES }).default('pending').notNull(),
  inforce: boolean('inforce'),
  requestedByName: text('requested_by_name').notNull(),
  requestedByUserId: integer('requested_by_user_id'),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  respondedAt: timestamp('responded_at'),
  isMock: boolean('is_mock').default(false).notNull(),
  // scripts/migrations/2026-10-11-sp8-eligibility-provider.sql
  providerId: integer('provider_id'),
}, (t) => [
  foreignKey({ name: 'nhcx_eligibility_checks_provider_fk', columns: [t.providerId], foreignColumns: [providers.id] }),
  foreignKey({ name: 'nhcx_eligibility_checks_patient_fk', columns: [t.patientId], foreignColumns: [patients.id] }),
  foreignKey({ name: 'nhcx_eligibility_checks_policy_fk', columns: [t.policyId], foreignColumns: [patientPolicies.id] }),
  foreignKey({ name: 'nhcx_eligibility_checks_payer_fk', columns: [t.payerId], foreignColumns: [payers.id] }),
  foreignKey({ name: 'nhcx_eligibility_checks_user_fk', columns: [t.requestedByUserId], foreignColumns: [users.id] }),
  index('nhcx_eligibility_patient_idx').on(t.patientId),
  check('nhcx_eligibility_checks_purpose_valid', sql`${t.purpose} IN (${inList(ELIGIBILITY_PURPOSES)})`),
  check('nhcx_eligibility_checks_context_valid', sql`${t.context} IN (${inList(ELIGIBILITY_CONTEXTS)})`),
  check('nhcx_eligibility_checks_status_valid', sql`${t.status} IN (${inList(ELIGIBILITY_STATUSES)})`),
])

// One row per NHCX message, outbound (the transactional outbox) or inbound. The outbound
// bundle itself is not stored (it is rebuilt from the SP7 snapshot); jwe_encrypted keeps the
// vault-sealed JWE only until NHCX accepts it, so a retry resends identical bytes.
export const nhcxExchanges = pgTable('nhcx_exchanges', {
  id: serial('id').primaryKey(),
  entityType: text('entity_type', { enum: NHCX_ENTITY_TYPES }).notNull(),
  direction: text('direction', { enum: NHCX_DIRECTIONS }).notNull(),
  action: text('action').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  apiCallId: uuid('api_call_id').notNull(),
  senderCode: text('sender_code').notNull(),
  recipientCode: text('recipient_code').notNull(),
  state: text('state', { enum: NHCX_EXCHANGE_STATES }).notNull(),
  protocolStatus: text('protocol_status'),
  patientId: text('patient_id').notNull(),
  policyId: integer('policy_id'),
  preauthId: integer('preauth_id'),
  preauthEventId: integer('preauth_event_id'),
  claimId: integer('claim_id'),
  claimSubmissionId: integer('claim_submission_id'),
  eligibilityCheckId: integer('eligibility_check_id'),
  rcmQueryId: integer('rcm_query_id'),
  relatedExchangeId: integer('related_exchange_id'),
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at'),
  lastErrorCode: text('last_error_code'),
  lastPolledAt: timestamp('last_polled_at'),
  bodySha256: text('body_sha256').notNull(),
  jweEncrypted: text('jwe_encrypted'),
  payloadEncrypted: text('payload_encrypted'),
  summary: jsonb('summary').$type<NhcxResponseSummary>(),
  reviewState: text('review_state', { enum: NHCX_REVIEW_STATES }).default('not_needed').notNull(),
  reviewedByName: text('reviewed_by_name'),
  reviewedAt: timestamp('reviewed_at'),
  isMock: boolean('is_mock').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  respondedAt: timestamp('responded_at'),
}, (t) => [
  unique('nhcx_exchanges_api_call_unique').on(t.apiCallId),
  foreignKey({ name: 'nhcx_exchanges_patient_fk', columns: [t.patientId], foreignColumns: [patients.id] }),
  foreignKey({ name: 'nhcx_exchanges_policy_fk', columns: [t.policyId], foreignColumns: [patientPolicies.id] }),
  foreignKey({ name: 'nhcx_exchanges_preauth_fk', columns: [t.preauthId], foreignColumns: [preauths.id] }),
  foreignKey({ name: 'nhcx_exchanges_preauth_event_fk', columns: [t.preauthEventId], foreignColumns: [preauthEvents.id] }),
  foreignKey({ name: 'nhcx_exchanges_claim_fk', columns: [t.claimId], foreignColumns: [claims.id] }),
  foreignKey({ name: 'nhcx_exchanges_claim_submission_fk', columns: [t.claimSubmissionId], foreignColumns: [claimSubmissions.id] }),
  foreignKey({ name: 'nhcx_exchanges_eligibility_check_fk', columns: [t.eligibilityCheckId], foreignColumns: [nhcxEligibilityChecks.id] }),
  foreignKey({ name: 'nhcx_exchanges_rcm_query_fk', columns: [t.rcmQueryId], foreignColumns: [rcmQueries.id] }),
  index('nhcx_exchanges_correlation_idx').on(t.correlationId),
  index('nhcx_exchanges_claim_idx').on(t.claimId),
  index('nhcx_exchanges_preauth_idx').on(t.preauthId),
  index('nhcx_exchanges_due_idx').on(t.state, t.nextAttemptAt),
  uniqueIndex('nhcx_exchanges_submission_unique').on(t.claimSubmissionId).where(sql`direction = 'outbound' AND claim_submission_id IS NOT NULL`),
  check('nhcx_exchanges_payload_direction', sql`(${t.direction} = 'inbound' OR ${t.payloadEncrypted} IS NULL) AND (${t.direction} = 'outbound' OR ${t.jweEncrypted} IS NULL)`),
  check('nhcx_exchanges_attempts_range', sql`${t.attempts} BETWEEN 0 AND 10`),
  check('nhcx_exchanges_entity_type_valid', sql`${t.entityType} IN (${inList(NHCX_ENTITY_TYPES)})`),
  check('nhcx_exchanges_direction_valid', sql`${t.direction} IN (${inList(NHCX_DIRECTIONS)})`),
  check('nhcx_exchanges_state_valid', sql`${t.state} IN (${inList(NHCX_EXCHANGE_STATES)})`),
  check('nhcx_exchanges_review_state_valid', sql`${t.reviewState} IN (${inList(NHCX_REVIEW_STATES)})`),
])

// Replay dedupe for inbound callbacks: ids only, purged after 30 days (Task 13).
export const nhcxInboundCalls = pgTable('nhcx_inbound_calls', {
  apiCallId: uuid('api_call_id').primaryKey(),
  action: text('action').notNull(),
  senderCode: text('sender_code').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  outcome: text('outcome', { enum: INBOUND_CALL_OUTCOMES }).notNull(),
  exchangeId: integer('exchange_id'),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
}, (t) => [
  index('nhcx_inbound_calls_received_idx').on(t.receivedAt),
  check('nhcx_inbound_calls_outcome_valid', sql`${t.outcome} IN (${inList(INBOUND_CALL_OUTCOMES)})`),
])

export type AbdmConsentRow = typeof abdmConsents.$inferSelect
export type AbdmProfileShareRow = typeof abdmProfileShares.$inferSelect
export type NhcxExchangeRow = typeof nhcxExchanges.$inferSelect
export type NhcxInboundCallRow = typeof nhcxInboundCalls.$inferSelect
export type NhcxEligibilityCheckRow = typeof nhcxEligibilityChecks.$inferSelect
// end SP8

export const noteTypeEnum = pgEnum('note_type', ['progress', 'nursing', 'intake'])
export const noteStatusEnum = pgEnum('note_status', ['draft', 'signed'])

export const encounterNotes = pgTable('encounter_notes', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  appointmentId: integer('appointment_id').references(() => appointments.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  noteType: noteTypeEnum('note_type').default('progress').notNull(),
  authorName: text('author_name').notNull(),
  authorRole: roleEnum('author_role').notNull(),
  subjective: text('subjective'),
  objective: text('objective'),
  assessment: text('assessment'),
  plan: text('plan'),
  status: noteStatusEnum('status').default('draft').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  signedAt: timestamp('signed_at'),
})

export const signableTypeEnum = pgEnum('signable_type', ['form_submission', 'admission_discharge', 'policy_acceptance', 'form_submission_consent'])

export const policyDocumentTypeEnum = pgEnum('policy_document_type', ['npp', 'tos'])

// The practice's Notice of Privacy Practices and Terms of Service, versioned
// so a later change never rewrites what an earlier patient actually agreed
// to. SECURITY/COMPLIANCE: bodyMarkdown below is seeded with clearly-marked
// DRAFT placeholder text -- it is NOT reviewed legal language and must be
// replaced by the practice's own attorney/compliance officer before any real
// patient relies on it. Never treat a draft row as ship-ready compliance
// copy; see docs/product-review-and-gap-analysis.md's HIPAA gap section.
export const policyDocuments = pgTable('policy_documents', {
  id: serial('id').primaryKey(),
  type: policyDocumentTypeEnum('type').notNull(),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  bodyMarkdown: text('body_markdown').notNull(),
  isDraft: boolean('is_draft').default(true).notNull(),
  effectiveDate: date('effective_date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// A generic, append-only signature event, keyed by (signableType, signableId)
// rather than a formSubmissionId/admissionId pair of nullable FKs -- same
// one-table-many-parents shape auditLog already uses in this codebase.
// signableId deliberately has NO FK: it means formSubmissions.id,
// admissions.id, policyDocuments.id or formSubmissionConsents.id depending
// on signableType, and a single FK column can't target several tables. This does NOT touch encounterNotes'
// existing status/signedAt signing mechanism -- that one stays as-is; see
// docs/superpowers/specs/2026-09-28-e-signatures.md §2.
export const signatures = pgTable('signatures', {
  id: serial('id').primaryKey(),
  signableType: signableTypeEnum('signable_type').notNull(),
  signableId: integer('signable_id').notNull(),
  // Nullable: form_submission/admission_discharge/form_submission_consent
  // signatures already resolve their patient by looking up signableId (a
  // formSubmissions/admissions row, or a formSubmissionConsents row via its
  // formSubmission, each of which has its own patientId). policy_acceptance's
  // signableId is a policyDocuments row shared by every patient, so THAT
  // signable type has no other way to know which patient signed -- this
  // column exists for it. Set it and every other signable type ignores it.
  patientId: text('patient_id').references(() => patients.id),
  signerTypedName: text('signer_typed_name').notNull(),
  signerRole: text('signer_role').notNull(), // free text: staff roles (admin/pi/crc/frontdesk) or 'patient' -- form-submission signatures are patient-portal-initiated, not staff
  attestationText: text('attestation_text').notNull(), // the exact attestation sentence shown at signing time, stored verbatim
  signedAt: timestamp('signed_at').defaultNow().notNull(),
})

export const medicationFormEnum = pgEnum('medication_form', ['tablet', 'capsule', 'liquid', 'injection', 'other'])

export const medications = pgTable('medications', {
  id: serial('id').primaryKey(),
  // UNIQUE (live-DB migration: medications_name_unique) -- added post-launch
  // by the final whole-branch review after a rename-without-cleanup bug
  // (seed matched by name before inserting, so renaming brand names to
  // generic names left the old brand-named rows in place instead of
  // updating them) produced 13 duplicate catalog rows with independently
  // split inventory. This constraint makes that failure mode impossible
  // going forward: a future rename-without-cleanup throws instead of
  // silently duplicating.
  name: text('name').notNull().unique(),
  genericName: text('generic_name'),
  medicationClass: text('medication_class').notNull(),
  commonDose: text('common_dose'),
  form: medicationFormEnum('form').default('tablet').notNull(),
})

export const medicationInventory = pgTable('medication_inventory', {
  id: serial('id').primaryKey(),
  medicationId: integer('medication_id').notNull().references(() => medications.id).unique(),
  quantityOnHand: integer('quantity_on_hand').default(0).notNull(),
  reorderThreshold: integer('reorder_threshold').default(10).notNull(),
  unit: text('unit').default('units').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const medicationDispenses = pgTable('medication_dispenses', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  medicationId: integer('medication_id').notNull().references(() => medications.id),
  medicationEpisodeId: integer('medication_episode_id').references(() => medicationEpisodes.id),
  quantity: integer('quantity').notNull(),
  dispensedByName: text('dispensed_by_name').notNull(),
  dispensedAt: timestamp('dispensed_at').defaultNow().notNull(),
  notes: text('notes'),
  // The dispense->bill link lives on this table, not as a
  // medicationDispenseId column on `charges`: charges is the general billing
  // table every service line shares, and "is this dispense billed yet" is a
  // property of the dispense. The .unique() is the real work -- it makes
  // double-billing one dispense a database-level impossibility rather than a
  // check the route has to remember, while still permitting unlimited NULLs
  // (Postgres does not treat NULLs as equal) for the many dispenses that are
  // samples or in-office doses and are never billed.
  chargeId: integer('charge_id').references(() => charges.id).unique(),
})

export const marStatusEnum = pgEnum('mar_status', ['scheduled', 'given', 'held', 'refused'])

export const medicationAdministrations = pgTable('medication_administrations', {
  id: serial('id').primaryKey(),
  admissionId: integer('admission_id').notNull().references(() => admissions.id),
  medicationEpisodeId: integer('medication_episode_id').references(() => medicationEpisodes.id),
  medicationName: text('medication_name').notNull(),
  dose: text('dose').notNull(),
  scheduledFor: timestamp('scheduled_for').notNull(),
  status: marStatusEnum('status').default('scheduled').notNull(),
  administeredAt: timestamp('administered_at'),
  administeredByName: text('administered_by_name'),
  notes: text('notes'),
})

export const eligibilityStatusEnum = pgEnum('eligibility_status', ['verified', 'inactive', 'needs_follow_up'])

export const insuranceEligibilityChecks = pgTable('insurance_eligibility_checks', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  payerName: text('payer_name').notNull(),
  payerId: integer('payer_id').references(() => payers.id),
  status: eligibilityStatusEnum('status').notNull(),
  copayCents: integer('copay_cents'),
  deductibleRemainingCents: integer('deductible_remaining_cents'),
  planType: insurancePlanTypeEnum('plan_type'),
  coverageStartDate: date('coverage_start_date'),
  checkedByName: text('checked_by_name').notNull(),
  checkedAt: timestamp('checked_at').defaultNow().notNull(),
})

export const documentStatusEnum = pgEnum('document_status', ['new', 'processed'])
export const documentTypeEnum = pgEnum('document_type', [
  'other', 'drivers_license', 'legal_document',
  'insurance_card_primary_front', 'insurance_card_primary_back',
  'insurance_card_secondary_front', 'insurance_card_secondary_back',
  'insurance_eob', 'insurance_authorization', 'imaging_result',
])
export const faxDeliveryStatusEnum = pgEnum('fax_delivery_status', ['delivered', 'failed'])

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  documentDate: date('document_date').notNull(),
  status: documentStatusEnum('status').default('new').notNull(),
  receivedFrom: text('received_from').notNull(),
  documentType: documentTypeEnum('document_type').default('other').notNull(),
  patientId: text('patient_id').references(() => patients.id),
  // Set only when staff explicitly associate the document with a stay -- never
  // derived from "whatever admission is active now." Cleared whenever
  // patientId changes or is cleared (see deletePatient's FK-ordering fix).
  admissionId: integer('admission_id').references(() => admissions.id),
  // Set only by the order-scoped upload route (which derives patientId from
  // the order itself), never by the generic documents routes -- so the two
  // can never disagree. labOrders is declared further below in this file;
  // the thunk here makes the forward reference legal.
  labOrderId: integer('lab_order_id').references(() => labOrders.id),
  // fileType is display metadata derived from the uploaded file's MIME type
  // (e.g. "PDF" / "JPG"). fileUrl is null only for pre-2026-09-29
  // metadata-only rows that predate real file storage.
  fileType: text('file_type').notNull(),
  fileUrl: text('file_url'),
  filedByName: text('filed_by_name'),
  filedAt: timestamp('filed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// `deliveryStatus` is a SIMULATED value set at seed/creation time by a mock
// rule -- this app never performs a real fax transmission. See the on-screen
// disclaimer on the Fax History tab (Task 12) and architecture spec §3.
export const faxes = pgTable('faxes', {
  id: serial('id').primaryKey(),
  faxDate: timestamp('fax_date').defaultNow().notNull(),
  subject: text('subject').notNull(),
  documentsIncluded: text('documents_included').notNull(), // free-text summary, e.g. "Consent Form.pdf" -- metadata only
  deliveryStatus: faxDeliveryStatusEnum('delivery_status').notNull(),
  sender: text('sender').notNull(),
  sentToFaxNumber: text('sent_to_fax_number').notNull(),
  patientId: text('patient_id').references(() => patients.id),
})

// A flat, single-thread-per-patient message log -- deliberately not a
// generic multi-party inbox, since that's how the rest of this app already
// models the doctor<->patient relationship (`patients.currentProvider` is
// free text; there's no formal doctor-assignment table). `senderName` is
// captured at send time (the staff member's display name, or the patient's
// own name) rather than resolved later from the current session/patient
// record, so the thread still reads correctly if either changes afterward.
// Any staff role (not just 'pi') may send as the provider side of the
// thread -- in real clinics the CRC often coordinates patient communication
// on the doctor's behalf, same reasoning as broadcasts.sentBy.
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  senderRole: text('sender_role', { enum: ['provider', 'patient', 'system'] }).notNull(),
  senderName: text('sender_name').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  readByPatientAt: timestamp('read_by_patient_at'),
  readByProviderAt: timestamp('read_by_provider_at'),
  // Staff-to-staff note about this patient (e.g. pharmacy confirming a
  // dispense with the prescriber) -- senderRole is still 'provider' (the
  // sender genuinely is staff), but `internal` keeps it out of every
  // patient-facing read of this thread. Pharmacy must be able to contact the
  // prescriber without that note ever reaching the patient portal.
  internal: boolean('internal').default(false).notNull(),
})

// SP5: values and order equal LAB_ORDER_STATUSES (src/lib/labs/status.ts). The four new values
// are added by scripts/migrations/2026-10-08-sp5-lab-enum-values.sql, each placed BEFORE/AFTER a
// pre-SP5 value so a migrated DB and a fresh db:push agree on this order.
export const labOrderStatusEnum = pgEnum('lab_order_status', ['ordered', 'scheduled', 'collected', 'received', 'resulted', 'verified', 'reported', 'cancelled'])
export const labResultFlagEnum = pgEnum('lab_result_flag', ['normal', 'abnormal', 'critical'])
export const labTestCategoryEnum = pgEnum('lab_test_category', ['lab', 'imaging'])
// SP5: values equal SAMPLE_TYPES / SAMPLE_CONTAINERS (src/lib/labs/catalog.ts); declared here
// because lab_tests uses them.
export const labSampleTypeEnum = pgEnum('lab_sample_type', ['blood', 'serum', 'plasma', 'urine', 'stool', 'sputum', 'swab', 'csf', 'other'])
export const labSampleContainerEnum = pgEnum('lab_sample_container', [
  'edta_lavender', 'plain_red', 'sst_gold', 'fluoride_grey', 'citrate_blue', 'heparin_green', 'urine_container', 'stool_container',
  'swab_tube', 'other',
])

export const labTests = pgTable('lab_tests', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull(), // a real, recognizable test code (LOINC-style), reference data only -- not verified against the real LOINC database
  // A catalog-level property: whether a study produces an image belongs to
  // the test itself, not to one patient's order for it.
  category: labTestCategoryEnum('category').default('lab').notNull(),
  defaultUnit: text('default_unit'),
  referenceRange: text('reference_range'),
  // SP5: sample/tube setup and the tariff service used to quote the test (all optional).
  sampleType: labSampleTypeEnum('sample_type'),
  container: labSampleContainerEnum('container'),
  serviceId: integer('service_id').references(() => serviceCatalog.id),
})

export const labOrders = pgTable('lab_orders', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  labTestId: integer('lab_test_id').notNull().references(() => labTests.id),
  orderedByProviderId: integer('ordered_by_provider_id').notNull().references(() => providers.id),
  status: labOrderStatusEnum('status').default('ordered').notNull(),
  orderedAt: timestamp('ordered_at').defaultNow().notNull(),
  collectedAt: timestamp('collected_at'),
  // SP5: requisition, home-collection visit, sample ID and lifecycle stamps, quoted price.
  // requisition_id stays nullable at DB level (Ruling 7): other branches' raw inserts keep
  // working; SP5 app code always sets it and the migration backfills legacy rows.
  // Explicit AnyPgColumn: lab_orders -> lab_requisitions -> follow_up_orders -> lab_orders is a
  // reference cycle TypeScript cannot infer through.
  requisitionId: integer('requisition_id').references((): AnyPgColumn => labRequisitions.id),
  homeCollectionVisitId: integer('home_collection_visit_id'),
  sampleId: text('sample_id').unique(),
  sampleDate: date('sample_date'),
  sampleSeq: integer('sample_seq'),
  collectedByName: text('collected_by_name'),
  receivedAt: timestamp('received_at'),
  receivedByName: text('received_by_name'),
  verifiedAt: timestamp('verified_at'),
  verifiedByName: text('verified_by_name'),
  verifiedByUserId: integer('verified_by_user_id').references(() => users.id),
  reportedAt: timestamp('reported_at'),
  cancelledAt: timestamp('cancelled_at'),
  cancelledByName: text('cancelled_by_name'),
  cancelReason: text('cancel_reason'),
  quotedPricePaise: integer('quoted_price_paise'),
  quotedTariffRateId: integer('quoted_tariff_rate_id').references(() => tariffRates.id),
  quotedOn: date('quoted_on'),
  quoteStatus: text('quote_status', { enum: ['quoted', 'unmapped', 'no_rate', 'service_inactive', 'service_not_found'] }).default('unmapped').notNull(),
  statusChangedAt: timestamp('status_changed_at'),
}, (t) => [
  // SP5. Explicit FK name: drizzle's default would be 64 characters, over Postgres's 63-character limit.
  foreignKey({ name: 'lab_orders_visit_id_fk', columns: [t.homeCollectionVisitId], foreignColumns: [homeCollectionVisits.id] }).onDelete('set null'),
  uniqueIndex('lab_orders_sample_date_seq_unique').on(t.sampleDate, t.sampleSeq),
  index('lab_orders_requisition_idx').on(t.requisitionId),
  index('lab_orders_visit_idx').on(t.homeCollectionVisitId),
  index('lab_orders_status_idx').on(t.status),
  check('lab_orders_quoted_price_range', sql`${t.quotedPricePaise} IS NULL OR ${t.quotedPricePaise} BETWEEN 0 AND 1000000000`),
  check('lab_orders_sample_pair', sql`(${t.sampleId} IS NULL) = (${t.sampleDate} IS NULL) AND (${t.sampleId} IS NULL) = (${t.sampleSeq} IS NULL)`),
  check('lab_orders_scheduled_has_visit', sql`${t.status} <> 'scheduled' OR ${t.homeCollectionVisitId} IS NOT NULL`),
])

export const labResults = pgTable('lab_results', {
  id: serial('id').primaryKey(),
  labOrderId: integer('lab_order_id').notNull().references(() => labOrders.id).unique(),
  value: text('value').notNull(),
  unit: text('unit'),
  referenceRange: text('reference_range'),
  flag: labResultFlagEnum('flag').default('normal').notNull(),
  resultedByName: text('resulted_by_name').notNull(),
  resultedAt: timestamp('resulted_at').defaultNow().notNull(),
  notes: text('notes'),
  // SP5: who entered the result (verifier separation) and when it was last amended.
  resultedByUserId: integer('resulted_by_user_id').references(() => users.id),
  amendedAt: timestamp('amended_at'),
})

// SP5 lab LIS & home collection (scripts/migrations/2026-10-08-sp5-lab-enum-values.sql, then
// scripts/migrations/2026-10-08-sp5-lab-home-collection.sql). Everything here is expressible in
// drizzle, so a fresh `db:push` creates the same objects.
export const homeCollectionStatusEnum = pgEnum('home_collection_status', ['booked', 'collected', 'cancelled'])
export const notificationChannelEnum = pgEnum('notification_channel', ['log', 'sms', 'whatsapp', 'email'])
export const notificationDeliveryStatusEnum = pgEnum('notification_delivery_status', ['logged', 'sent', 'failed', 'suppressed_opt_out', 'skipped_no_contact'])
export const labReportSeq = pgSequence('lab_report_seq', { startWith: 1, increment: 1 })

// Admin-managed list of PIN codes the lab collects from ("local patient", Ruling 3).
export const labServiceAreaPins = pgTable('lab_service_area_pins', {
  id: serial('id').primaryKey(),
  pinCode: text('pin_code').notNull().unique(),
  areaLabel: text('area_label'),
  isActive: boolean('is_active').default(true).notNull(),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  check('lab_service_area_pins_pin_format', sql`${t.pinCode} ~ '^[1-9][0-9]{5}$'`),
])

// Collection windows: 'HH:MM' IST strings with a per-(date, window) capacity.
export const homeCollectionWindows = pgTable('home_collection_windows', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  capacity: integer('capacity').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  check('home_collection_windows_time_format', sql`${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check('home_collection_windows_time_order', sql`${t.startTime} < ${t.endTime}`),
  check('home_collection_windows_capacity_range', sql`${t.capacity} BETWEEN 1 AND 50`),
])

// A doctor's order of one or more tests: the unit for the patient notice, the report and the
// follow-up request (Ruling 7). legacy_lab_order_id is the backfill key only (no FK).
export const labRequisitions = pgTable('lab_requisitions', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  orderedByProviderId: integer('ordered_by_provider_id').notNull().references(() => providers.id),
  originatingEncounterId: integer('originating_encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
  followUpRequested: boolean('follow_up_requested').default(false).notNull(),
  followUpIntervalValue: integer('follow_up_interval_value'),
  followUpIntervalUnit: followUpIntervalUnitEnum('follow_up_interval_unit'),
  followUpReason: text('follow_up_reason'),
  followUpOrderId: integer('follow_up_order_id').references(() => followUpOrders.id, { onDelete: 'set null' }),
  followUpResolvedAt: timestamp('follow_up_resolved_at'),
  followUpOutcome: text('follow_up_outcome', { enum: ['created', 'linked', 'failed'] }),
  legacyLabOrderId: integer('legacy_lab_order_id').unique(),
  createdByName: text('created_by_name').notNull(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  check('lab_requisitions_follow_up_fields', sql`(NOT ${t.followUpRequested} AND ${t.followUpIntervalValue} IS NULL AND ${t.followUpIntervalUnit} IS NULL) OR (${t.followUpRequested} AND ${t.followUpIntervalValue} BETWEEN 1 AND 365 AND ${t.followUpIntervalUnit} IS NOT NULL)`),
  index('lab_requisitions_patient_idx').on(t.patientId),
])

// One home sample-collection trip: a slot (IST date + window snapshot), an address snapshot
// and an optional collector. At most one booked visit per patient per slot.
export const homeCollectionVisits = pgTable('home_collection_visits', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  visitDate: date('visit_date').notNull(),
  windowId: integer('window_id').notNull().references(() => homeCollectionWindows.id),
  windowLabel: text('window_label').notNull(),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  status: homeCollectionStatusEnum('status').default('booked').notNull(),
  addressLine1: text('address_line1').notNull(),
  addressLine2: text('address_line2'),
  city: text('city').notNull(),
  district: text('district'),
  stateCode: text('state_code').notNull(),
  pinCode: text('pin_code').notNull(),
  landmark: text('landmark'),
  contactPhone: text('contact_phone').notNull(),
  notes: text('notes'),
  collectorUserId: integer('collector_user_id').references(() => users.id),
  collectorAssignedAt: timestamp('collector_assigned_at'),
  collectorAssignedByName: text('collector_assigned_by_name'),
  bookedByName: text('booked_by_name').notNull(),
  bookedByUserId: integer('booked_by_user_id').references(() => users.id),
  bookedAt: timestamp('booked_at').defaultNow().notNull(),
  rescheduleCount: integer('reschedule_count').default(0).notNull(),
  lastRescheduleReason: text('last_reschedule_reason'),
  lastRescheduleNote: text('last_reschedule_note'),
  cancelledAt: timestamp('cancelled_at'),
  cancelledByName: text('cancelled_by_name'),
  cancelReason: text('cancel_reason'),
  cancelNote: text('cancel_note'),
  collectedAt: timestamp('collected_at'),
  collectedByName: text('collected_by_name'),
  encounterId: integer('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('home_collection_visits_patient_slot_unique').on(t.patientId, t.visitDate, t.windowId).where(sql`status = 'booked'`),
  index('home_collection_visits_date_window_idx').on(t.visitDate, t.windowId),
  index('home_collection_visits_collector_date_idx').on(t.collectorUserId, t.visitDate),
  check('home_collection_visits_pin_format', sql`${t.pinCode} ~ '^[1-9][0-9]{5}$'`),
  check('home_collection_visits_cancel_reason', sql`${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL`),
  check('home_collection_visits_collected_at', sql`${t.status} <> 'collected' OR ${t.collectedAt} IS NOT NULL`),
])

// A released PDF lab report (one version per release; a re-release supersedes the previous one).
// blob_url is server-side only (Ruling 6).
export const labReports = pgTable('lab_reports', {
  id: serial('id').primaryKey(),
  reportNumber: text('report_number').notNull().unique(),
  requisitionId: integer('requisition_id').notNull().references(() => labRequisitions.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  version: integer('version').notNull(),
  orderIds: jsonb('order_ids').$type<number[]>().notNull(),
  testSummary: text('test_summary').notNull(),
  blobUrl: text('blob_url').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  releasedByName: text('released_by_name').notNull(),
  releasedByUserId: integer('released_by_user_id').references(() => users.id),
  releasedAt: timestamp('released_at').defaultNow().notNull(),
  supersededAt: timestamp('superseded_at'),
}, (t) => [
  uniqueIndex('lab_reports_requisition_version_unique').on(t.requisitionId, t.version),
  index('lab_reports_patient_idx').on(t.patientId),
  check('lab_reports_version_positive', sql`${t.version} > 0`),
])

// Delivery log of every patient notice attempt (sent, logged, suppressed or skipped).
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  templateKey: text('template_key').notNull(),
  channel: notificationChannelEnum('channel').notNull(),
  status: notificationDeliveryStatusEnum('status').notNull(),
  destinationMasked: text('destination_masked'),
  relatedType: text('related_type'),
  relatedId: integer('related_id'),
  dedupeKey: text('dedupe_key').unique(),
  errorCode: text('error_code'),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('notification_deliveries_patient_idx').on(t.patientId),
  index('notification_deliveries_related_idx').on(t.relatedType, t.relatedId),
])

export type LabOrderRow = typeof labOrders.$inferSelect
export type LabRequisitionRow = typeof labRequisitions.$inferSelect
export type HomeCollectionVisitRow = typeof homeCollectionVisits.$inferSelect
export type HomeCollectionWindowRow = typeof homeCollectionWindows.$inferSelect
export type ServiceAreaPinRow = typeof labServiceAreaPins.$inferSelect
export type LabReportRow = typeof labReports.$inferSelect
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect
// end SP5 lab LIS & home collection

export const employmentStatusEnum = pgEnum('employment_status', ['active', 'on_leave', 'terminated'])

// A staff directory that deliberately mixes three linkage shapes: some rows
// are both a system `users` login AND a clinical `providers` row (e.g. a
// prescribing psychiatrist who also logs into the app), some are only one
// or the other, and some (front-desk/facilities roles) are neither -- see
// the seed data below and spec §1. Both FKs are therefore nullable, not
// `.notNull()`, matching users.id/providers.id's own serial/integer shape.
export const staffMembers = pgTable('staff_members', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  providerId: integer('provider_id').references(() => providers.id),
  name: text('name').notNull(),
  department: text('department').notNull(),
  title: text('title').notNull(),
  employmentStatus: employmentStatusEnum('employment_status').default('active').notNull(),
  hireDate: date('hire_date').notNull(),
  terminationDate: date('termination_date'),
})

export const staffCredentials = pgTable('staff_credentials', {
  id: serial('id').primaryKey(),
  staffMemberId: integer('staff_member_id').notNull().references(() => staffMembers.id),
  credentialType: text('credential_type').notNull(),
  credentialNumber: text('credential_number'),
  expiresOn: date('expires_on'),
})

export const carePlanStatusEnum = pgEnum('care_plan_status', ['active', 'superseded'])
export const carePlanGoalStatusEnum = pgEnum('care_plan_goal_status', ['active', 'met', 'not_met', 'discontinued'])

export const carePlans = pgTable('care_plans', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  title: text('title').notNull(),
  authorName: text('author_name').notNull(),
  status: carePlanStatusEnum('status').default('active').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  nextReviewDate: date('next_review_date'),
  supersededAt: timestamp('superseded_at'),
})

export const carePlanGoals = pgTable('care_plan_goals', {
  id: serial('id').primaryKey(),
  carePlanId: integer('care_plan_id').notNull().references(() => carePlans.id),
  description: text('description').notNull(),
  targetDate: date('target_date'),
  status: carePlanGoalStatusEnum('status').default('active').notNull(),
  statusUpdatedAt: timestamp('status_updated_at'),
  statusUpdatedByName: text('status_updated_by_name'),
})

// -- Trial regulatory-compliance tables --------------------------------
// A real CRC's job is not just pre-screening: they're the site's
// operational owner of trial execution, which includes reporting adverse
// events to the sponsor/IRB on a clock, keeping a drug accountability log
// (separate from routine clinical dispensing -- this tracks the STUDY
// drug's chain of custody: lot numbers, what was received/dispensed/
// returned/destroyed), and maintaining the regulatory binder (1572s,
// delegation log, IRB approvals, protocol versions). All three are scoped
// to a trial, not a patient alone, so they live under
// /trials/[trialId] rather than as a patient-chart tab.

export const adverseEventSeverityEnum = pgEnum('adverse_event_severity', ['mild', 'moderate', 'severe'])
// Standard 5-point causality assessment used across real trial AE forms --
// "how likely is it this was caused by the study drug, not something else".
export const adverseEventCausalityEnum = pgEnum('adverse_event_causality', ['unrelated', 'unlikely', 'possibly', 'probably', 'definitely'])
export const adverseEventOutcomeEnum = pgEnum('adverse_event_outcome', ['resolved', 'resolving', 'ongoing', 'fatal', 'unknown'])

export const adverseEvents = pgTable('adverse_events', {
  id: serial('id').primaryKey(),
  trialId: text('trial_id').notNull().references(() => trials.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  description: text('description').notNull(),
  severity: adverseEventSeverityEnum('severity').notNull(),
  // A Serious Adverse Event (SAE) is a distinct regulatory category from
  // "severe" -- a mild event can still be serious (e.g. any hospitalization
  // counts, regardless of how severe the symptom itself was) -- so this is
  // its own flag, not derived from severity.
  serious: boolean('serious').default(false).notNull(),
  causality: adverseEventCausalityEnum('causality').notNull(),
  outcome: adverseEventOutcomeEnum('outcome').default('ongoing').notNull(),
  onsetDate: date('onset_date').notNull(),
  reportedDate: date('reported_date').notNull(),
  reportedByName: text('reported_by_name').notNull(),
  // Null until actually notified -- an SAE with reportedDate more than a
  // day in the past and still null here is overdue (real sites must notify
  // sponsors within ~24 hours of becoming aware of an SAE).
  sponsorNotifiedAt: timestamp('sponsor_notified_at'),
  irbNotifiedAt: timestamp('irb_notified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const drugAccountabilityActionEnum = pgEnum('drug_accountability_action', ['received', 'dispensed', 'returned', 'destroyed'])

export const drugAccountabilityEntries = pgTable('drug_accountability_entries', {
  id: serial('id').primaryKey(),
  trialId: text('trial_id').notNull().references(() => trials.id),
  // Null for a site-level entry (e.g. a shipment "received" from the
  // sponsor, which isn't about any one patient yet) -- non-null once study
  // drug is dispensed to, or returned by, a specific participant.
  patientId: text('patient_id').references(() => patients.id),
  lotNumber: text('lot_number').notNull(),
  expirationDate: date('expiration_date').notNull(),
  action: drugAccountabilityActionEnum('action').notNull(),
  quantity: integer('quantity').notNull(),
  performedByName: text('performed_by_name').notNull(),
  date: date('date').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const regulatoryDocumentTypeEnum = pgEnum('regulatory_document_type', [
  'form_1572', 'delegation_log', 'irb_approval', 'informed_consent_template', 'protocol', 'investigator_brochure', 'other',
])
export const regulatoryDocumentStatusEnum = pgEnum('regulatory_document_status', ['current', 'expired', 'superseded'])

export const regulatoryDocuments = pgTable('regulatory_documents', {
  id: serial('id').primaryKey(),
  trialId: text('trial_id').notNull().references(() => trials.id),
  documentType: regulatoryDocumentTypeEnum('document_type').notNull(),
  title: text('title').notNull(),
  version: text('version'),
  effectiveDate: date('effective_date').notNull(),
  // IRB approvals in particular expire annually and must be renewed -- null
  // means this document type doesn't expire (e.g. a signed 1572).
  expirationDate: date('expiration_date'),
  status: regulatoryDocumentStatusEnum('status').default('current').notNull(),
  uploadedByName: text('uploaded_by_name').notNull(),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
})

// Wave G (P2-01): per-user read state for the staff notification feed
// (scripts/migrations/2026-10-09-wave-g-staff-notification-reads.sql). The feed is
// computed from live events; this only records which items a user has read.
// user_key = 'u:<users.id>', or 'n:<role>:<name>' for a session with no users row.
export const staffNotificationReads = pgTable('staff_notification_reads', {
  userKey: text('user_key').notNull(),
  itemKey: text('item_key').notNull(),
  readAt: timestamp('read_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.userKey, t.itemKey] }),
  index('staff_notification_reads_read_at_idx').on(t.readAt),
])
// end Wave G
