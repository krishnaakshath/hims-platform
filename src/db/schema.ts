import { pgTable, text, timestamp, date, boolean, jsonb, integer, pgEnum, serial, uniqueIndex } from 'drizzle-orm/pg-core'

export const verdictEnum = pgEnum('verdict', ['green', 'yellow', 'red'])
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs'])
export const mfaMethodEnum = pgEnum('mfa_method', ['totp', 'sms', 'email'])
export const payerTypeEnum = pgEnum('payer_type', ['commercial', 'medicare', 'medicaid', 'tricare', 'other'])
export const insuranceRelationshipEnum = pgEnum('insurance_relationship', ['self', 'spouse', 'child', 'other'])
export const insurancePlanTypeEnum = pgEnum('insurance_plan_type', ['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid'])

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
})

export const diagnoses = pgTable('diagnoses', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  code: text('code').notNull(),
  description: text('description').notNull(),
  date: date('date'),
})

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
export const idTypeEnum = pgEnum('id_type', ['drivers_license', 'state_id', 'passport', 'military_id', 'green_card'])
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

// Single-row table: one settings record for the whole pilot deployment.
export const appSettings = pgTable('app_settings', {
  id: serial('id').primaryKey(),
  autoClassifyOnComplete: boolean('auto_classify_on_complete').default(false).notNull(),
  practiceName: text('practice_name'),
  practiceSite: text('practice_site'),
  practiceTimezone: text('practice_timezone').default('America/Los_Angeles'),
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
})

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
})

export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied', 'dirty', 'blocked'])

export const rooms = pgTable('rooms', {
  id: serial('id').primaryKey(),
  ward: text('ward').notNull(),
  roomNumber: text('room_number').notNull(),
  bedNumber: text('bed_number').notNull(),
  status: roomStatusEnum('status').default('available').notNull(),
  blockedReason: text('blocked_reason'),
  occupiedByPatientId: text('occupied_by_patient_id').references(() => patients.id),
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

export const labOrderStatusEnum = pgEnum('lab_order_status', ['ordered', 'collected', 'resulted', 'cancelled'])
export const labResultFlagEnum = pgEnum('lab_result_flag', ['normal', 'abnormal', 'critical'])
export const labTestCategoryEnum = pgEnum('lab_test_category', ['lab', 'imaging'])

export const labTests = pgTable('lab_tests', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull(), // a real, recognizable test code (LOINC-style), reference data only -- not verified against the real LOINC database
  // A catalog-level property: whether a study produces an image belongs to
  // the test itself, not to one patient's order for it.
  category: labTestCategoryEnum('category').default('lab').notNull(),
  defaultUnit: text('default_unit'),
  referenceRange: text('reference_range'),
})

export const labOrders = pgTable('lab_orders', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  labTestId: integer('lab_test_id').notNull().references(() => labTests.id),
  orderedByProviderId: integer('ordered_by_provider_id').notNull().references(() => providers.id),
  status: labOrderStatusEnum('status').default('ordered').notNull(),
  orderedAt: timestamp('ordered_at').defaultNow().notNull(),
  collectedAt: timestamp('collected_at'),
})

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
})

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
