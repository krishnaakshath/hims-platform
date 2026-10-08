-- Baseline schema for an EMPTY database (scripts/db/migrate.ts applies it first,
-- then every scripts/migrations/*.sql in name order).
--
-- Generated on 2026-10-08 from src/db/schema.ts at the commit that introduced the
-- migration ledger, with:
--   npx drizzle-kit export --dialect postgresql --schema ./src/db/schema.ts
--
-- FROZEN. Do not edit or regenerate this file: its checksum is recorded in every
-- database's schema_migrations ledger and the runner refuses to run if it changes.
-- Every later schema change is a new, idempotent file in scripts/migrations/.
--
-- Not in here (migration-only, cannot be expressed in schema.ts): the btree_gist
-- and pg_trgm extensions, the tariff_rates_no_overlap exclusion constraint, the
-- codes_display_trgm_idx index and the SP4 billing immutability triggers.
CREATE TYPE "public"."admission_status" AS ENUM('admitted', 'discharged');
CREATE TYPE "public"."admission_type" AS ENUM('elective', 'emergency', 'transfer_in');
CREATE TYPE "public"."adverse_event_causality" AS ENUM('unrelated', 'unlikely', 'possibly', 'probably', 'definitely');
CREATE TYPE "public"."adverse_event_outcome" AS ENUM('resolved', 'resolving', 'ongoing', 'fatal', 'unknown');
CREATE TYPE "public"."adverse_event_severity" AS ENUM('mild', 'moderate', 'severe');
CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show');
CREATE TYPE "public"."blood_group" AS ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown');
CREATE TYPE "public"."booking_request_status" AS ENUM('pending', 'confirmed', 'declined');
CREATE TYPE "public"."broadcast_channel" AS ENUM('sms', 'email', 'both');
CREATE TYPE "public"."broadcast_form_status_filter" AS ENUM('sent', 'partial', 'completed', 'none');
CREATE TYPE "public"."care_plan_goal_status" AS ENUM('active', 'met', 'not_met', 'discontinued');
CREATE TYPE "public"."care_plan_status" AS ENUM('active', 'superseded');
CREATE TYPE "public"."charge_line_source" AS ENUM('manual', 'room_rent', 'pharmacy');
CREATE TYPE "public"."charge_line_status" AS ENUM('captured', 'invoiced', 'void');
CREATE TYPE "public"."charge_status" AS ENUM('draft', 'pending_approval', 'approved', 'submitted');
CREATE TYPE "public"."code_entry_status" AS ENUM('uncoded', 'proposed', 'coded');
CREATE TYPE "public"."code_system_kind" AS ENUM('icd10', 'icd10pcs', 'snomed', 'loinc', 'hbp');
CREATE TYPE "public"."coding_event_action" AS ENUM('claim', 'assign', 'release', 'raise_query', 'resume', 'mark_coded', 'finalise', 'reopen', 'edit_after_coded');
CREATE TYPE "public"."coding_query_status" AS ENUM('open', 'answered', 'closed', 'withdrawn');
CREATE TYPE "public"."department_kind" AS ENUM('clinical', 'diagnostic', 'support', 'administrative');
CREATE TYPE "public"."diagnosis_type" AS ENUM('primary', 'secondary', 'provisional');
CREATE TYPE "public"."doctor_assignment_status" AS ENUM('pending', 'scheduled', 'declined');
CREATE TYPE "public"."doctor_assignment_urgency" AS ENUM('routine', 'urgent', 'emergency');
CREATE TYPE "public"."doctor_assignment_visit_type" AS ENUM('inpatient', 'outpatient');
CREATE TYPE "public"."document_series" AS ENUM('invoice', 'receipt', 'credit_note', 'refund');
CREATE TYPE "public"."document_status" AS ENUM('new', 'processed');
CREATE TYPE "public"."document_type" AS ENUM('other', 'drivers_license', 'legal_document', 'insurance_card_primary_front', 'insurance_card_primary_back', 'insurance_card_secondary_front', 'insurance_card_secondary_back', 'insurance_eob', 'insurance_authorization', 'imaging_result');
CREATE TYPE "public"."drug_accountability_action" AS ENUM('received', 'dispensed', 'returned', 'destroyed');
CREATE TYPE "public"."eligibility_status" AS ENUM('verified', 'inactive', 'needs_follow_up');
CREATE TYPE "public"."employment_status" AS ENUM('active', 'on_leave', 'terminated');
CREATE TYPE "public"."encounter_coding_status" AS ENUM('uncoded', 'in_progress', 'queried', 'coded', 'finalised');
CREATE TYPE "public"."encounter_status" AS ENUM('checked_in', 'in_consultation', 'completed', 'cancelled');
CREATE TYPE "public"."encounter_type" AS ENUM('opd', 'ipd', 'lab');
CREATE TYPE "public"."encounter_visit_type" AS ENUM('new', 'follow_up', 'review', 'emergency');
CREATE TYPE "public"."fax_delivery_status" AS ENUM('delivered', 'failed');
CREATE TYPE "public"."follow_up_contact_channel" AS ENUM('phone', 'sms', 'whatsapp', 'email', 'in_person');
CREATE TYPE "public"."follow_up_contact_outcome" AS ENUM('reached_booked', 'reached_will_call_back', 'reached_declined', 'no_answer', 'wrong_number', 'message_left');
CREATE TYPE "public"."follow_up_interval_unit" AS ENUM('days', 'weeks', 'months');
CREATE TYPE "public"."follow_up_source" AS ENUM('encounter', 'discharge', 'lab_report', 'manual');
CREATE TYPE "public"."follow_up_status" AS ENUM('planned', 'scheduled', 'completed', 'missed', 'cancelled');
CREATE TYPE "public"."form_submission_status" AS ENUM('sent', 'partial', 'completed');
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'transgender', 'other', 'unknown');
CREATE TYPE "public"."home_collection_status" AS ENUM('booked', 'collected', 'cancelled');
CREATE TYPE "public"."id_type" AS ENUM('drivers_license', 'state_id', 'passport', 'military_id', 'green_card', 'voter_id', 'pan', 'ration_card');
CREATE TYPE "public"."insurance_claim_status" AS ENUM('rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid');
CREATE TYPE "public"."insurance_plan_type" AS ENUM('ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid');
CREATE TYPE "public"."insurance_relationship" AS ENUM('self', 'spouse', 'child', 'other');
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'finalised', 'cancelled', 'discarded');
CREATE TYPE "public"."lab_order_status" AS ENUM('ordered', 'scheduled', 'collected', 'received', 'resulted', 'verified', 'reported', 'cancelled');
CREATE TYPE "public"."lab_result_flag" AS ENUM('normal', 'abnormal', 'critical');
CREATE TYPE "public"."lab_sample_container" AS ENUM('edta_lavender', 'plain_red', 'sst_gold', 'fluoride_grey', 'citrate_blue', 'heparin_green', 'urine_container', 'stool_container', 'swab_tube', 'other');
CREATE TYPE "public"."lab_sample_type" AS ENUM('blood', 'serum', 'plasma', 'urine', 'stool', 'sputum', 'swab', 'csf', 'other');
CREATE TYPE "public"."lab_test_category" AS ENUM('lab', 'imaging');
CREATE TYPE "public"."legal_review_status" AS ENUM('draft', 'reviewed');
CREATE TYPE "public"."mar_status" AS ENUM('scheduled', 'given', 'held', 'refused');
CREATE TYPE "public"."marital_status" AS ENUM('single', 'married', 'divorced', 'widowed', 'separated', 'unknown');
CREATE TYPE "public"."medication_form" AS ENUM('tablet', 'capsule', 'liquid', 'injection', 'other');
CREATE TYPE "public"."mfa_method" AS ENUM('totp', 'sms', 'email');
CREATE TYPE "public"."mock_payment_result" AS ENUM('success', 'failed');
CREATE TYPE "public"."note_status" AS ENUM('draft', 'signed');
CREATE TYPE "public"."note_type" AS ENUM('progress', 'nursing', 'intake');
CREATE TYPE "public"."notification_channel" AS ENUM('log', 'sms', 'whatsapp', 'email');
CREATE TYPE "public"."notification_delivery_status" AS ENUM('logged', 'sent', 'failed', 'suppressed_opt_out', 'skipped_no_contact');
CREATE TYPE "public"."patient_contact_kind" AS ENUM('next_of_kin', 'guardian', 'emergency');
CREATE TYPE "public"."patient_payment_kind" AS ENUM('advance', 'receipt');
CREATE TYPE "public"."payer_type" AS ENUM('commercial', 'medicare', 'medicaid', 'tricare', 'other');
CREATE TYPE "public"."payment_mode" AS ENUM('cash', 'upi', 'card', 'cheque', 'neft', 'other');
CREATE TYPE "public"."policy_document_type" AS ENUM('npp', 'tos');
CREATE TYPE "public"."registration_council" AS ENUM('nmc', 'smc');
CREATE TYPE "public"."regulatory_document_status" AS ENUM('current', 'expired', 'superseded');
CREATE TYPE "public"."regulatory_document_type" AS ENUM('form_1572', 'delegation_log', 'irb_approval', 'informed_consent_template', 'protocol', 'investigator_brochure', 'other');
CREATE TYPE "public"."role" AS ENUM('crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector');
CREATE TYPE "public"."room_status" AS ENUM('available', 'occupied', 'dirty', 'blocked');
CREATE TYPE "public"."service_category" AS ENUM('consultation', 'procedure', 'investigation_lab', 'investigation_imaging', 'room_rent', 'nursing', 'pharmacy', 'consumable', 'package', 'other');
CREATE TYPE "public"."severity" AS ENUM('mild', 'moderate', 'severe');
CREATE TYPE "public"."signable_type" AS ENUM('form_submission', 'admission_discharge', 'policy_acceptance', 'form_submission_consent');
CREATE TYPE "public"."statement_delivery_method" AS ENUM('email', 'sms', 'paper');
CREATE TYPE "public"."statement_delivery_status" AS ENUM('delivered', 'failed');
CREATE TYPE "public"."statement_type" AS ENUM('initial', 'reminder', 'final_notice');
CREATE TYPE "public"."survey_status" AS ENUM('sent', 'completed');
CREATE TYPE "public"."telemedicine_session_status" AS ENUM('scheduled', 'waiting', 'in_progress', 'completed', 'failed');
CREATE TYPE "public"."telemedicine_signal_sender" AS ENUM('provider', 'patient');
CREATE TYPE "public"."telemedicine_signal_type" AS ENUM('offer', 'answer', 'ice_candidate');
CREATE TYPE "public"."verdict" AS ENUM('green', 'yellow', 'red');
CREATE SEQUENCE "public"."lab_report_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
CREATE SEQUENCE "public"."uhid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
CREATE TABLE "admission_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"admission_id" integer NOT NULL,
	"from_room_id" integer,
	"to_room_id" integer NOT NULL,
	"reason" text NOT NULL,
	"transferred_by_name" text NOT NULL,
	"transferred_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "admissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"current_room_id" integer,
	"attending_provider_id" integer NOT NULL,
	"admission_type" "admission_type" DEFAULT 'elective' NOT NULL,
	"status" "admission_status" DEFAULT 'admitted' NOT NULL,
	"admitted_at" timestamp DEFAULT now() NOT NULL,
	"discharged_at" timestamp,
	"discharge_diagnosis" text,
	"discharge_drugs" text,
	"discharge_devices" text,
	"discharge_diet" text,
	"discharge_summary_notes" text,
	"follow_up_appointment_id" integer,
	"created_from_assignment_id" integer
);

CREATE TABLE "adverse_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"trial_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"description" text NOT NULL,
	"severity" "adverse_event_severity" NOT NULL,
	"serious" boolean DEFAULT false NOT NULL,
	"causality" "adverse_event_causality" NOT NULL,
	"outcome" "adverse_event_outcome" DEFAULT 'ongoing' NOT NULL,
	"onset_date" date NOT NULL,
	"reported_date" date NOT NULL,
	"reported_by_name" text NOT NULL,
	"sponsor_notified_at" timestamp,
	"irb_notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "allergies" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"allergen" text NOT NULL,
	"reaction" text,
	"severity" "severity" NOT NULL
);

CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"auto_classify_on_complete" boolean DEFAULT false NOT NULL,
	"practice_name" text,
	"practice_site" text,
	"practice_timezone" text DEFAULT 'Asia/Kolkata',
	"uhid_prefix" text DEFAULT 'UH' NOT NULL,
	"admin_mfa_secret_encrypted" text,
	"admin_mfa_enabled" boolean DEFAULT false NOT NULL,
	"admin_mfa_method" "mfa_method" DEFAULT 'totp' NOT NULL,
	"admin_phone" text,
	"queue_display_pin" text
);

CREATE TABLE "appointments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"visit_reason" text NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_name" text NOT NULL,
	"role" "role",
	"action" text NOT NULL,
	"patient_id" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"details" text
);

CREATE TABLE "billing_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"legal_name" text,
	"gstin" text,
	"state_code" text,
	"address" text,
	"place_of_supply_mode" text DEFAULT 'location_of_service' NOT NULL,
	"consultation_window_days" integer DEFAULT 30 NOT NULL,
	"ipd_deposit_threshold_paise" integer DEFAULT 0 NOT NULL,
	"room_rent_service_id" integer,
	"pharmacy_gst_rate_bp" integer DEFAULT 500 NOT NULL,
	"pharmacy_hsn" text DEFAULT '3004' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_name" text,
	CONSTRAINT "billing_settings_singleton" CHECK ("billing_settings"."id" = 1),
	CONSTRAINT "billing_settings_consultation_window_range" CHECK ("billing_settings"."consultation_window_days" BETWEEN 1 AND 365),
	CONSTRAINT "billing_settings_deposit_threshold_range" CHECK ("billing_settings"."ipd_deposit_threshold_paise" BETWEEN 0 AND 1000000000),
	CONSTRAINT "billing_settings_pharmacy_gst_allowed" CHECK ("billing_settings"."pharmacy_gst_rate_bp" IN (0, 500, 1200, 1800, 2800, 4000))
);

CREATE TABLE "booking_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requester_name" text NOT NULL,
	"requester_dob" date NOT NULL,
	"requester_email" text,
	"requester_phone" text,
	"preferred_provider_id" integer,
	"preferred_date_range_start" date NOT NULL,
	"preferred_date_range_end" date NOT NULL,
	"reason" text NOT NULL,
	"status" "booking_request_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_by_name" text,
	"reviewed_at" timestamp,
	"decline_reason" text,
	"resulting_appointment_id" integer
);

CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text,
	"message" text NOT NULL,
	"channel" "broadcast_channel" NOT NULL,
	"filter_trial_id" text,
	"filter_overall_status" "verdict",
	"filter_form_status" "broadcast_form_status_filter",
	"recipients" jsonb NOT NULL,
	"recipient_count" integer NOT NULL,
	"sent_by" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "care_plan_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"care_plan_id" integer NOT NULL,
	"description" text NOT NULL,
	"target_date" date,
	"status" "care_plan_goal_status" DEFAULT 'active' NOT NULL,
	"status_updated_at" timestamp,
	"status_updated_by_name" text
);

CREATE TABLE "care_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"title" text NOT NULL,
	"author_name" text NOT NULL,
	"status" "care_plan_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"next_review_date" date,
	"superseded_at" timestamp
);

CREATE TABLE "charge_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" integer,
	"admission_id" integer,
	"source" charge_line_source NOT NULL,
	"status" charge_line_status DEFAULT 'captured' NOT NULL,
	"service_id" integer,
	"item_code" text NOT NULL,
	"item_name" text NOT NULL,
	"service_category" "service_category",
	"department_id" integer,
	"ordering_provider_id" integer,
	"performing_provider_id" integer,
	"service_date" date NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"price_source" text NOT NULL,
	"tariff_rate_id" integer,
	"resolved_price_paise" integer,
	"price_override_reason" text,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"hsn_sac" text NOT NULL,
	"payer_id" integer,
	"pre_auth_reference" text,
	"procedure_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"legacy_charge_id" integer,
	"medication_dispense_id" integer,
	"void_reason" text,
	"voided_at" timestamp,
	"voided_by_name" text,
	"created_by_name" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"invoice_id" integer,
	CONSTRAINT "charge_lines_legacy_charge_id_unique" UNIQUE("legacy_charge_id"),
	CONSTRAINT "charge_lines_medication_dispense_id_unique" UNIQUE("medication_dispense_id"),
	CONSTRAINT "charge_lines_quantity_range" CHECK ("charge_lines"."quantity" BETWEEN 1 AND 1000),
	CONSTRAINT "charge_lines_unit_price_range" CHECK ("charge_lines"."unit_price_paise" BETWEEN 0 AND 1000000000),
	CONSTRAINT "charge_lines_taxable_nonneg" CHECK ("charge_lines"."taxable_paise" >= 0),
	CONSTRAINT "charge_lines_gst_rate_allowed" CHECK ("charge_lines"."gst_rate_bp" IN (0, 500, 1200, 1800, 2800, 4000)),
	CONSTRAINT "charge_lines_service_required" CHECK ("charge_lines"."source" = 'pharmacy' OR "charge_lines"."service_id" IS NOT NULL),
	CONSTRAINT "charge_lines_context_required" CHECK ("charge_lines"."source" = 'pharmacy' OR "charge_lines"."encounter_id" IS NOT NULL OR "charge_lines"."admission_id" IS NOT NULL),
	CONSTRAINT "charge_lines_manual_reason" CHECK ("charge_lines"."price_source" <> 'manual' OR "charge_lines"."price_override_reason" IS NOT NULL),
	CONSTRAINT "charge_lines_void_reason" CHECK ("charge_lines"."status" <> 'void' OR "charge_lines"."void_reason" IS NOT NULL)
);

CREATE TABLE "charge_rule_configs" (
	"rule_code" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_name" text NOT NULL
);

CREATE TABLE "charges" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"provider_name" text NOT NULL,
	"date_of_service" date NOT NULL,
	"diagnosis_codes" jsonb NOT NULL,
	"procedure_codes" jsonb NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" charge_status DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "code_systems" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "code_system_kind" NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"licence_note" text,
	"source_file_name" text NOT NULL,
	"source_sha256" text NOT NULL,
	"code_count" integer NOT NULL,
	"imported_by_name" text NOT NULL,
	"imported_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "code_systems_count_nonneg" CHECK ("code_systems"."code_count" >= 0),
	CONSTRAINT "code_systems_licence_unless_sample" CHECK ("code_systems"."is_sample" OR "code_systems"."licence_note" IS NOT NULL)
);

CREATE TABLE "codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_system_id" integer NOT NULL,
	"code" text NOT NULL,
	"display" text NOT NULL,
	"parent_code" text,
	"selectable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"sex_restriction" text,
	"age_min_years" integer,
	"age_max_years" integer,
	"excludes" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "codes_effective_range" CHECK ("codes"."effective_to" IS NULL OR "codes"."effective_from" IS NULL OR "codes"."effective_to" >= "codes"."effective_from"),
	CONSTRAINT "codes_age_range" CHECK (("codes"."age_min_years" IS NULL OR "codes"."age_min_years" BETWEEN 0 AND 150) AND ("codes"."age_max_years" IS NULL OR "codes"."age_max_years" BETWEEN 0 AND 150) AND ("codes"."age_min_years" IS NULL OR "codes"."age_max_years" IS NULL OR "codes"."age_min_years" <= "codes"."age_max_years"))
);

CREATE TABLE "coding_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"encounter_id" integer NOT NULL,
	"patient_id" text NOT NULL,
	"addressed_to_provider_id" integer NOT NULL,
	"question" text NOT NULL,
	"status" "coding_query_status" DEFAULT 'open' NOT NULL,
	"raised_by_name" text NOT NULL,
	"raised_by_user_id" integer,
	"raised_at" timestamp DEFAULT now() NOT NULL,
	"answered_at" timestamp,
	"closed_at" timestamp,
	"closed_by_name" text,
	CONSTRAINT "coding_queries_question_len" CHECK (char_length("coding_queries"."question") BETWEEN 1 AND 1000)
);

CREATE TABLE "coding_query_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"query_id" integer NOT NULL,
	"author_name" text NOT NULL,
	"author_role" "role" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coding_query_responses_body_len" CHECK (char_length("coding_query_responses"."body") BETWEEN 1 AND 2000)
);

CREATE TABLE "consent_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"body_text" text NOT NULL,
	"legal_review_status" "legal_review_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "credit_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"credit_note_number" text NOT NULL,
	"invoice_id" integer NOT NULL,
	"financial_year" text NOT NULL,
	"issue_date" date NOT NULL,
	"reason" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"issued_by_name" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_credit_note_number_unique" UNIQUE("credit_note_number"),
	CONSTRAINT "credit_notes_invoice_id_unique" UNIQUE("invoice_id")
);

CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "department_kind" DEFAULT 'clinical' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "departments_code_unique" UNIQUE("code")
);

CREATE TABLE "diagnoses" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"date" date,
	"encounter_id" integer,
	"code_id" integer,
	"code_system_kind" "code_system_kind",
	"code_display" text,
	"diagnosis_type" "diagnosis_type",
	"coding_status" "code_entry_status" DEFAULT 'uncoded' NOT NULL,
	"sequence" integer,
	"proposed_by_name" text,
	"proposed_at" timestamp,
	"coded_by_name" text,
	"coded_at" timestamp,
	"voided_at" timestamp,
	"voided_by_name" text,
	"created_by_name" text,
	"created_at" timestamp,
	CONSTRAINT "diagnoses_coded_complete" CHECK ("diagnoses"."coding_status" <> 'coded' OR ("diagnoses"."code_id" IS NOT NULL AND "diagnoses"."encounter_id" IS NOT NULL AND "diagnoses"."diagnosis_type" IS NOT NULL)),
	CONSTRAINT "diagnoses_proposed_has_code" CHECK ("diagnoses"."coding_status" <> 'proposed' OR "diagnoses"."code_id" IS NOT NULL),
	CONSTRAINT "diagnoses_code_kind_pair" CHECK (("diagnoses"."code_id" IS NULL) = ("diagnoses"."code_system_kind" IS NULL))
);

CREATE TABLE "doctor_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"visit_type" "doctor_assignment_visit_type" NOT NULL,
	"urgency" "doctor_assignment_urgency" DEFAULT 'routine' NOT NULL,
	"reason" text NOT NULL,
	"status" "doctor_assignment_status" DEFAULT 'pending' NOT NULL,
	"room_id" integer,
	"assigned_by_name" text NOT NULL,
	"appointment_id" integer,
	"decline_reason" text,
	"queue_ticket_number" integer DEFAULT 0 NOT NULL,
	"patient_notified_at" timestamp,
	"decline_acknowledged_at" timestamp,
	"decline_acknowledged_by_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "document_counters" (
	"series" "document_series" NOT NULL,
	"financial_year" text NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_counters_pk" PRIMARY KEY("series","financial_year"),
	CONSTRAINT "document_counters_fy_format" CHECK ("document_counters"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "document_counters_value_range" CHECK ("document_counters"."last_value" BETWEEN 0 AND 999999)
);

CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"document_date" date NOT NULL,
	"status" "document_status" DEFAULT 'new' NOT NULL,
	"received_from" text NOT NULL,
	"document_type" "document_type" DEFAULT 'other' NOT NULL,
	"patient_id" text,
	"admission_id" integer,
	"lab_order_id" integer,
	"file_type" text NOT NULL,
	"file_url" text,
	"filed_by_name" text,
	"filed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "drug_accountability_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"trial_id" text NOT NULL,
	"patient_id" text,
	"lot_number" text NOT NULL,
	"expiration_date" date NOT NULL,
	"action" "drug_accountability_action" NOT NULL,
	"quantity" integer NOT NULL,
	"performed_by_name" text NOT NULL,
	"date" date NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "encounter_coding" (
	"encounter_id" integer PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"status" "encounter_coding_status" DEFAULT 'uncoded' NOT NULL,
	"assigned_to_user_id" integer,
	"assigned_to_name" text,
	"assigned_at" timestamp,
	"coded_at" timestamp,
	"coded_by_name" text,
	"finalised_at" timestamp,
	"finalised_by_name" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_coding_finalised_stamp" CHECK ("encounter_coding"."status" <> 'finalised' OR "encounter_coding"."finalised_at" IS NOT NULL)
);

CREATE TABLE "encounter_coding_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"encounter_id" integer NOT NULL,
	"action" "coding_event_action" NOT NULL,
	"from_status" "encounter_coding_status" NOT NULL,
	"to_status" "encounter_coding_status" NOT NULL,
	"reason" text,
	"by_name" text NOT NULL,
	"by_user_id" integer,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_coding_events_reason_len" CHECK ("encounter_coding_events"."reason" IS NULL OR char_length("encounter_coding_events"."reason") <= 500)
);

CREATE TABLE "encounter_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" integer,
	"admission_id" integer,
	"note_type" "note_type" DEFAULT 'progress' NOT NULL,
	"author_name" text NOT NULL,
	"author_role" "role" NOT NULL,
	"subjective" text,
	"objective" text,
	"assessment" text,
	"plan" text,
	"status" "note_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"signed_at" timestamp
);

CREATE TABLE "encounter_procedures" (
	"id" serial PRIMARY KEY NOT NULL,
	"encounter_id" integer NOT NULL,
	"patient_id" text NOT NULL,
	"description" text NOT NULL,
	"code_id" integer,
	"code_system_kind" "code_system_kind",
	"code" text,
	"code_display" text,
	"coding_status" "code_entry_status" DEFAULT 'uncoded' NOT NULL,
	"performed_on" date NOT NULL,
	"performed_by_provider_id" integer,
	"service_id" integer,
	"sequence" integer,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"proposed_by_name" text,
	"proposed_at" timestamp,
	"coded_by_name" text,
	"coded_at" timestamp,
	"voided_at" timestamp,
	"voided_by_name" text,
	CONSTRAINT "encounter_procedures_code_required" CHECK ("encounter_procedures"."coding_status" = 'uncoded' OR ("encounter_procedures"."code_id" IS NOT NULL AND "encounter_procedures"."code" IS NOT NULL)),
	CONSTRAINT "encounter_procedures_code_kind_pair" CHECK (("encounter_procedures"."code_id" IS NULL) = ("encounter_procedures"."code_system_kind" IS NULL))
);

CREATE TABLE "encounters" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_type" "encounter_type" NOT NULL,
	"visit_type" "encounter_visit_type" DEFAULT 'new' NOT NULL,
	"status" "encounter_status" DEFAULT 'checked_in' NOT NULL,
	"encounter_date" date NOT NULL,
	"opd_token" integer,
	"department_id" integer,
	"provider_id" integer NOT NULL,
	"appointment_id" integer,
	"admission_id" integer,
	"doctor_assignment_id" integer,
	"checked_in_by_name" text NOT NULL,
	"checked_in_at" timestamp DEFAULT now() NOT NULL,
	"status_changed_at" timestamp,
	"status_changed_by_name" text,
	"completed_at" timestamp,
	"cancel_reason" text,
	CONSTRAINT "encounters_appointment_id_unique" UNIQUE("appointment_id"),
	CONSTRAINT "encounters_admission_id_unique" UNIQUE("admission_id"),
	CONSTRAINT "encounters_doctor_assignment_id_unique" UNIQUE("doctor_assignment_id"),
	CONSTRAINT "encounters_token_positive" CHECK ("encounters"."opd_token" IS NULL OR "encounters"."opd_token" > 0)
);

CREATE TABLE "faxes" (
	"id" serial PRIMARY KEY NOT NULL,
	"fax_date" timestamp DEFAULT now() NOT NULL,
	"subject" text NOT NULL,
	"documents_included" text NOT NULL,
	"delivery_status" "fax_delivery_status" NOT NULL,
	"sender" text NOT NULL,
	"sent_to_fax_number" text NOT NULL,
	"patient_id" text
);

CREATE TABLE "follow_up_contact_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"follow_up_order_id" integer NOT NULL,
	"channel" "follow_up_contact_channel" NOT NULL,
	"outcome" "follow_up_contact_outcome" NOT NULL,
	"note" text,
	"attempted_by_name" text NOT NULL,
	"attempted_by_user_id" integer,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "follow_up_contact_attempts_note_len" CHECK ("follow_up_contact_attempts"."note" IS NULL OR char_length("follow_up_contact_attempts"."note") <= 500)
);

CREATE TABLE "follow_up_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"source" "follow_up_source" NOT NULL,
	"status" "follow_up_status" DEFAULT 'planned' NOT NULL,
	"prescribed_by_provider_id" integer NOT NULL,
	"department_id" integer,
	"base_date" date NOT NULL,
	"due_date" date NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"interval_value" integer,
	"interval_unit" "follow_up_interval_unit",
	"reason" text NOT NULL,
	"plan_notes" text,
	"originating_encounter_id" integer,
	"originating_admission_id" integer,
	"originating_lab_order_id" integer,
	"appointment_id" integer,
	"completed_encounter_id" integer,
	"created_by_name" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"plan_updated_at" timestamp,
	"plan_updated_by_name" text,
	"scheduled_at" timestamp,
	"scheduled_by_name" text,
	"scheduled_by_user_id" integer,
	"completed_at" timestamp,
	"cancelled_at" timestamp,
	"cancelled_by_name" text,
	"cancel_reason" text,
	CONSTRAINT "follow_up_orders_appointment_id_unique" UNIQUE("appointment_id"),
	CONSTRAINT "follow_up_orders_window_order" CHECK ("follow_up_orders"."window_start" <= "follow_up_orders"."due_date" AND "follow_up_orders"."due_date" <= "follow_up_orders"."window_end"),
	CONSTRAINT "follow_up_orders_interval_pair" CHECK (("follow_up_orders"."interval_value" IS NULL) = ("follow_up_orders"."interval_unit" IS NULL) AND ("follow_up_orders"."interval_value" IS NULL OR "follow_up_orders"."interval_value" > 0)),
	CONSTRAINT "follow_up_orders_cancel_reason" CHECK ("follow_up_orders"."status" <> 'cancelled' OR "follow_up_orders"."cancel_reason" IS NOT NULL)
);

CREATE TABLE "form_chart_discrepancies" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"form_submission_id" integer NOT NULL,
	"question_id" text NOT NULL,
	"question_label" text NOT NULL,
	"patient_answer" text NOT NULL,
	"chart_finding" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp
);

CREATE TABLE "form_submission_consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_submission_id" integer NOT NULL,
	"consent_document_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "form_submission_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_submission_id" integer NOT NULL,
	"total_score" integer NOT NULL,
	"band_label" text NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "form_submission_scores_form_submission_id_unique" UNIQUE("form_submission_id")
);

CREATE TABLE "form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"patient_id" text NOT NULL,
	"status" "form_submission_status" DEFAULT 'sent' NOT NULL,
	"sent_date" timestamp DEFAULT now() NOT NULL,
	"completed_date" timestamp,
	"answers" jsonb DEFAULT '{}'::jsonb,
	"access_token" text,
	"token_expires_at" timestamp,
	CONSTRAINT "form_submissions_access_token_unique" UNIQUE("access_token")
);

CREATE TABLE "form_template_consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_template_id" integer NOT NULL,
	"consent_document_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "form_template_folders" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "form_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"folder_id" integer,
	"diagnosis_tag" text NOT NULL,
	"questions" jsonb NOT NULL,
	"scoring_rule" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "home_collection_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"visit_date" date NOT NULL,
	"window_id" integer NOT NULL,
	"window_label" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"status" "home_collection_status" DEFAULT 'booked' NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"district" text,
	"state_code" text NOT NULL,
	"pin_code" text NOT NULL,
	"landmark" text,
	"contact_phone" text NOT NULL,
	"notes" text,
	"collector_user_id" integer,
	"collector_assigned_at" timestamp,
	"collector_assigned_by_name" text,
	"booked_by_name" text NOT NULL,
	"booked_by_user_id" integer,
	"booked_at" timestamp DEFAULT now() NOT NULL,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"last_reschedule_reason" text,
	"last_reschedule_note" text,
	"cancelled_at" timestamp,
	"cancelled_by_name" text,
	"cancel_reason" text,
	"cancel_note" text,
	"collected_at" timestamp,
	"collected_by_name" text,
	"encounter_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "home_collection_visits_pin_format" CHECK ("home_collection_visits"."pin_code" ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "home_collection_visits_cancel_reason" CHECK ("home_collection_visits"."status" <> 'cancelled' OR "home_collection_visits"."cancel_reason" IS NOT NULL),
	CONSTRAINT "home_collection_visits_collected_at" CHECK ("home_collection_visits"."status" <> 'collected' OR "home_collection_visits"."collected_at" IS NOT NULL)
);

CREATE TABLE "home_collection_windows" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"capacity" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "home_collection_windows_time_format" CHECK ("home_collection_windows"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "home_collection_windows"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "home_collection_windows_time_order" CHECK ("home_collection_windows"."start_time" < "home_collection_windows"."end_time"),
	CONSTRAINT "home_collection_windows_capacity_range" CHECK ("home_collection_windows"."capacity" BETWEEN 1 AND 50)
);

CREATE TABLE "identity_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"id_type" "id_type" NOT NULL,
	"id_number_encrypted" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	CONSTRAINT "identity_verifications_patient_id_unique" UNIQUE("patient_id")
);

CREATE TABLE "insurance_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"charge_id" integer NOT NULL,
	"patient_id" text NOT NULL,
	"payer_name" text NOT NULL,
	"payer_id" integer,
	"billed_amount_cents" integer NOT NULL,
	"paid_amount_cents" integer,
	"status" "insurance_claim_status" NOT NULL,
	"submitted_date" date NOT NULL,
	"notes" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "insurance_eligibility_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"payer_name" text NOT NULL,
	"payer_id" integer,
	"status" "eligibility_status" NOT NULL,
	"copay_cents" integer,
	"deductible_remaining_cents" integer,
	"plan_type" "insurance_plan_type",
	"coverage_start_date" date,
	"checked_by_name" text NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"charge_line_id" integer NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL,
	"item_name" text NOT NULL,
	"hsn_sac" text NOT NULL,
	"service_date" date NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"price_source" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"cgst_rate_bp" integer NOT NULL,
	"sgst_rate_bp" integer NOT NULL,
	"igst_rate_bp" integer NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL
);

CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" integer,
	"admission_id" integer,
	"payer_id" integer,
	"financial_year" text,
	"invoice_date" date,
	"document_title" text,
	"supply_type" text,
	"place_of_supply_state_code" text,
	"snapshot" jsonb,
	"taxable_paise" bigint,
	"cgst_paise" bigint,
	"sgst_paise" bigint,
	"igst_paise" bigint,
	"total_paise" bigint,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finalised_at" timestamp,
	"finalised_by_name" text,
	"cancelled_at" timestamp,
	"cancelled_by_name" text,
	"discarded_at" timestamp,
	"discarded_by_name" text,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "invoices_number_when_issued" CHECK (("invoices"."status" IN ('finalised', 'cancelled')) = ("invoices"."invoice_number" IS NOT NULL)),
	CONSTRAINT "invoices_totals_when_issued" CHECK ("invoices"."status" NOT IN ('finalised', 'cancelled') OR ("invoices"."total_paise" IS NOT NULL AND "invoices"."snapshot" IS NOT NULL AND "invoices"."invoice_date" IS NOT NULL))
);

CREATE TABLE "lab_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"lab_test_id" integer NOT NULL,
	"ordered_by_provider_id" integer NOT NULL,
	"status" "lab_order_status" DEFAULT 'ordered' NOT NULL,
	"ordered_at" timestamp DEFAULT now() NOT NULL,
	"collected_at" timestamp,
	"requisition_id" integer,
	"home_collection_visit_id" integer,
	"sample_id" text,
	"sample_date" date,
	"sample_seq" integer,
	"collected_by_name" text,
	"received_at" timestamp,
	"received_by_name" text,
	"verified_at" timestamp,
	"verified_by_name" text,
	"verified_by_user_id" integer,
	"reported_at" timestamp,
	"cancelled_at" timestamp,
	"cancelled_by_name" text,
	"cancel_reason" text,
	"quoted_price_paise" integer,
	"quoted_tariff_rate_id" integer,
	"quoted_on" date,
	"quote_status" text DEFAULT 'unmapped' NOT NULL,
	"status_changed_at" timestamp,
	CONSTRAINT "lab_orders_sample_id_unique" UNIQUE("sample_id"),
	CONSTRAINT "lab_orders_quoted_price_range" CHECK ("lab_orders"."quoted_price_paise" IS NULL OR "lab_orders"."quoted_price_paise" BETWEEN 0 AND 1000000000),
	CONSTRAINT "lab_orders_sample_pair" CHECK (("lab_orders"."sample_id" IS NULL) = ("lab_orders"."sample_date" IS NULL) AND ("lab_orders"."sample_id" IS NULL) = ("lab_orders"."sample_seq" IS NULL)),
	CONSTRAINT "lab_orders_scheduled_has_visit" CHECK ("lab_orders"."status" <> 'scheduled' OR "lab_orders"."home_collection_visit_id" IS NOT NULL)
);

CREATE TABLE "lab_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_number" text NOT NULL,
	"requisition_id" integer NOT NULL,
	"patient_id" text NOT NULL,
	"version" integer NOT NULL,
	"order_ids" jsonb NOT NULL,
	"test_summary" text NOT NULL,
	"blob_url" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"released_by_name" text NOT NULL,
	"released_by_user_id" integer,
	"released_at" timestamp DEFAULT now() NOT NULL,
	"superseded_at" timestamp,
	CONSTRAINT "lab_reports_report_number_unique" UNIQUE("report_number"),
	CONSTRAINT "lab_reports_version_positive" CHECK ("lab_reports"."version" > 0)
);

CREATE TABLE "lab_requisitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"ordered_by_provider_id" integer NOT NULL,
	"originating_encounter_id" integer,
	"follow_up_requested" boolean DEFAULT false NOT NULL,
	"follow_up_interval_value" integer,
	"follow_up_interval_unit" "follow_up_interval_unit",
	"follow_up_reason" text,
	"follow_up_order_id" integer,
	"follow_up_resolved_at" timestamp,
	"follow_up_outcome" text,
	"legacy_lab_order_id" integer,
	"created_by_name" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lab_requisitions_legacy_lab_order_id_unique" UNIQUE("legacy_lab_order_id"),
	CONSTRAINT "lab_requisitions_follow_up_fields" CHECK ((NOT "lab_requisitions"."follow_up_requested" AND "lab_requisitions"."follow_up_interval_value" IS NULL AND "lab_requisitions"."follow_up_interval_unit" IS NULL) OR ("lab_requisitions"."follow_up_requested" AND "lab_requisitions"."follow_up_interval_value" BETWEEN 1 AND 365 AND "lab_requisitions"."follow_up_interval_unit" IS NOT NULL))
);

CREATE TABLE "lab_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"lab_order_id" integer NOT NULL,
	"value" text NOT NULL,
	"unit" text,
	"reference_range" text,
	"flag" "lab_result_flag" DEFAULT 'normal' NOT NULL,
	"resulted_by_name" text NOT NULL,
	"resulted_at" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	"resulted_by_user_id" integer,
	"amended_at" timestamp,
	CONSTRAINT "lab_results_lab_order_id_unique" UNIQUE("lab_order_id")
);

CREATE TABLE "lab_service_area_pins" (
	"id" serial PRIMARY KEY NOT NULL,
	"pin_code" text NOT NULL,
	"area_label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lab_service_area_pins_pin_code_unique" UNIQUE("pin_code"),
	CONSTRAINT "lab_service_area_pins_pin_format" CHECK ("lab_service_area_pins"."pin_code" ~ '^[1-9][0-9]{5}$')
);

CREATE TABLE "lab_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"category" "lab_test_category" DEFAULT 'lab' NOT NULL,
	"default_unit" text,
	"reference_range" text,
	"sample_type" "lab_sample_type",
	"container" "lab_sample_container",
	"service_id" integer
);

CREATE TABLE "medication_administrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"admission_id" integer NOT NULL,
	"medication_episode_id" integer,
	"medication_name" text NOT NULL,
	"dose" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"status" "mar_status" DEFAULT 'scheduled' NOT NULL,
	"administered_at" timestamp,
	"administered_by_name" text,
	"notes" text
);

CREATE TABLE "medication_dispenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"medication_id" integer NOT NULL,
	"medication_episode_id" integer,
	"quantity" integer NOT NULL,
	"dispensed_by_name" text NOT NULL,
	"dispensed_at" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	"charge_id" integer,
	CONSTRAINT "medication_dispenses_charge_id_unique" UNIQUE("charge_id")
);

CREATE TABLE "medication_episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"name" text NOT NULL,
	"medication_class" text NOT NULL,
	"dose" text,
	"start_date" date NOT NULL,
	"stop_date" date,
	"status" text NOT NULL,
	"medication_id" integer,
	"frequency_per_day" integer,
	"duration_days" integer,
	"instructions" text,
	"prescribed_by_provider_id" integer,
	"entered_by_name" text,
	"prescribed_at" timestamp
);

CREATE TABLE "medication_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"medication_id" integer NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 10 NOT NULL,
	"unit" text DEFAULT 'units' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "medication_inventory_medication_id_unique" UNIQUE("medication_id")
);

CREATE TABLE "medications" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"medication_class" text NOT NULL,
	"common_dose" text,
	"form" "medication_form" DEFAULT 'tablet' NOT NULL,
	CONSTRAINT "medications_name_unique" UNIQUE("name")
);

CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"sender_role" text NOT NULL,
	"sender_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_by_patient_at" timestamp,
	"read_by_provider_at" timestamp,
	"internal" boolean DEFAULT false NOT NULL
);

CREATE TABLE "mock_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"charge_id" integer,
	"amount_cents" integer NOT NULL,
	"card_last4" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"result" "mock_payment_result" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "notification_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"template_key" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" NOT NULL,
	"destination_masked" text,
	"related_type" text,
	"related_id" integer,
	"dedupe_key" text,
	"error_code" text,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_dedupe_key_unique" UNIQUE("dedupe_key")
);

CREATE TABLE "patient_aadhaar" (
	"patient_id" text PRIMARY KEY NOT NULL,
	"aadhaar_encrypted" text,
	"aadhaar_last4" text,
	"consent_given" boolean DEFAULT false NOT NULL,
	"consent_recorded_at" timestamp,
	"decline_reason" text,
	"decline_note" text,
	"recorded_by_name" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "patient_aadhaar_value_xor_decline" CHECK (("patient_aadhaar"."aadhaar_encrypted" IS NOT NULL AND "patient_aadhaar"."aadhaar_last4" ~ '^[0-9]{4}$' AND "patient_aadhaar"."consent_given" AND "patient_aadhaar"."decline_reason" IS NULL) OR ("patient_aadhaar"."aadhaar_encrypted" IS NULL AND "patient_aadhaar"."aadhaar_last4" IS NULL AND "patient_aadhaar"."decline_reason" IS NOT NULL))
);

CREATE TABLE "patient_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"kind" "patient_contact_kind" NOT NULL,
	"name" text NOT NULL,
	"relationship" text NOT NULL,
	"phone" text NOT NULL,
	"address_text" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "patient_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"receipt_number" text NOT NULL,
	"kind" "patient_payment_kind" NOT NULL,
	"patient_id" text NOT NULL,
	"admission_id" integer,
	"encounter_id" integer,
	"invoice_id" integer,
	"mode" "payment_mode" NOT NULL,
	"reference" text,
	"amount_paise" bigint NOT NULL,
	"financial_year" text NOT NULL,
	"receipt_date" date NOT NULL,
	"received_by_name" text NOT NULL,
	"received_by_user_id" integer,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "patient_payments_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "patient_payments_amount_positive" CHECK ("patient_payments"."amount_paise" > 0),
	CONSTRAINT "patient_payments_reference_required" CHECK ("patient_payments"."mode" = 'cash' OR "patient_payments"."reference" IS NOT NULL)
);

CREATE TABLE "patient_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"delivery_method" "statement_delivery_method" NOT NULL,
	"type" "statement_type" NOT NULL,
	"delivery_status" "statement_delivery_status" NOT NULL,
	"sent_date" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "patient_trial_screenings" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"trial_id" text NOT NULL,
	"overall_status" "verdict" NOT NULL,
	"selection_confirmed_at" timestamp,
	"selection_confirmed_by_name" text,
	"selection_notified_at" timestamp
);

CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"date_added" timestamp DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"dob" date NOT NULL,
	"city" text,
	"zip" text,
	"phone" text,
	"email" text,
	"current_provider" text,
	"rating_scales" jsonb DEFAULT '[]'::jsonb,
	"referral_type" text,
	"availability" text,
	"last_appt_date" date,
	"next_appt_date" date,
	"comm_consent_signed" boolean DEFAULT false,
	"comm_consent_pref" text,
	"template_doc_url" text,
	"prescreening_sent_date" date,
	"portal_password_hash" text,
	"last_communication" text,
	"form_notes" text,
	"reviewer_notes" text,
	"clinician_reviewer_notes" text,
	"pi_recommendation" text,
	"old_notes" text,
	"old_recs" text,
	"outside_meds_confirmation" text,
	"chart_data_as_of" timestamp DEFAULT now() NOT NULL,
	"mfa_secret_encrypted" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"primary_payer_id" integer,
	"primary_member_id" text,
	"primary_group_number" text,
	"primary_plan_type" "insurance_plan_type",
	"primary_subscriber_name" text,
	"primary_subscriber_relationship" "insurance_relationship",
	"primary_card_front_url" text,
	"primary_card_back_url" text,
	"secondary_payer_id" integer,
	"secondary_member_id" text,
	"secondary_group_number" text,
	"secondary_plan_type" "insurance_plan_type",
	"secondary_subscriber_name" text,
	"secondary_subscriber_relationship" "insurance_relationship",
	"uhid" text,
	"gender" "gender",
	"marital_status" "marital_status",
	"blood_group" "blood_group",
	"occupation" text,
	"nationality" text DEFAULT 'IN',
	"religion" text,
	"preferred_language" text,
	"photo_blob_path" text,
	"address_line1" text,
	"address_line2" text,
	"district" text,
	"state_code" text,
	"pin_code" text,
	"abha_number" text,
	"abha_address" text,
	"abha_unavailable_reason" text,
	"abha_unavailable_note" text,
	"is_mlc" boolean DEFAULT false NOT NULL,
	"mlc_number" text,
	"notification_opt_out" boolean DEFAULT false NOT NULL,
	"notification_opt_out_at" timestamp,
	CONSTRAINT "patients_uhid_unique" UNIQUE("uhid"),
	CONSTRAINT "patients_abha_number_unique" UNIQUE("abha_number"),
	CONSTRAINT "patients_abha_address_unique" UNIQUE("abha_address")
);

CREATE TABLE "payers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payer_id" text NOT NULL,
	"payer_type" "payer_type" DEFAULT 'commercial' NOT NULL,
	"requires_preauth" boolean DEFAULT false NOT NULL,
	"gstin" text,
	"state_code" text
);

CREATE TABLE "policy_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "policy_document_type" NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"is_draft" boolean DEFAULT true NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"credentials" text,
	"specialty" text NOT NULL,
	"color_tag" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"department_id" integer,
	"registration_council" "registration_council",
	"registration_state_code" text,
	"registration_number" text,
	"consultation_fee_paise" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	CONSTRAINT "providers_consultation_fee_nonneg" CHECK ("providers"."consultation_fee_paise" IS NULL OR "providers"."consultation_fee_paise" >= 0)
);

CREATE TABLE "refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"refund_number" text NOT NULL,
	"patient_id" text NOT NULL,
	"admission_id" integer,
	"against_payment_id" integer,
	"mode" "payment_mode" NOT NULL,
	"reference" text,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"financial_year" text NOT NULL,
	"refund_date" date NOT NULL,
	"issued_by_name" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_refund_number_unique" UNIQUE("refund_number"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_paise" > 0),
	CONSTRAINT "refunds_reference_required" CHECK ("refunds"."mode" = 'cash' OR "refunds"."reference" IS NOT NULL)
);

CREATE TABLE "regulatory_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"trial_id" text NOT NULL,
	"document_type" "regulatory_document_type" NOT NULL,
	"title" text NOT NULL,
	"version" text,
	"effective_date" date NOT NULL,
	"expiration_date" date,
	"status" "regulatory_document_status" DEFAULT 'current' NOT NULL,
	"uploaded_by_name" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"form_submission_id" integer NOT NULL,
	"status" "survey_status" DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"rating_overall" integer,
	"rating_forms_clarity" integer,
	"rating_communication" integer,
	"comments" text,
	"sent_by" text NOT NULL
);

CREATE TABLE "room_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "room_categories_code_unique" UNIQUE("code")
);

CREATE TABLE "rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"ward" text NOT NULL,
	"room_number" text NOT NULL,
	"bed_number" text NOT NULL,
	"status" "room_status" DEFAULT 'available' NOT NULL,
	"blocked_reason" text,
	"occupied_by_patient_id" text,
	"room_category_id" integer
);

CREATE TABLE "screening_criteria_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"screening_id" integer NOT NULL,
	"criterion_key" text NOT NULL,
	"criterion_text" text NOT NULL,
	"criterion_type" text,
	"verdict" "verdict" NOT NULL,
	"evidence_quote" text,
	"evidence_source_doc" text,
	"evidence_source_date" date
);

CREATE TABLE "service_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"department_id" integer NOT NULL,
	"category" "service_category" NOT NULL,
	"hsn_sac" text NOT NULL,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"requires_preauth" boolean DEFAULT false NOT NULL,
	"max_quantity" integer,
	CONSTRAINT "service_catalog_code_unique" UNIQUE("code"),
	CONSTRAINT "service_catalog_gst_rate_bp_allowed" CHECK ("service_catalog"."gst_rate_bp" IN (0, 500, 1200, 1800, 2800, 4000)),
	CONSTRAINT "service_catalog_max_quantity_range" CHECK ("service_catalog"."max_quantity" IS NULL OR "service_catalog"."max_quantity" BETWEEN 1 AND 1000)
);

CREATE TABLE "service_package_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_service_id" integer NOT NULL,
	"item_service_id" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "service_package_items_qty_positive" CHECK ("service_package_items"."quantity" > 0),
	CONSTRAINT "service_package_items_not_self" CHECK ("service_package_items"."package_service_id" <> "service_package_items"."item_service_id")
);

CREATE TABLE "service_procedure_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"code_system_kind" "code_system_kind" NOT NULL,
	"code" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "signatures" (
	"id" serial PRIMARY KEY NOT NULL,
	"signable_type" "signable_type" NOT NULL,
	"signable_id" integer NOT NULL,
	"patient_id" text,
	"signer_typed_name" text NOT NULL,
	"signer_role" text NOT NULL,
	"attestation_text" text NOT NULL,
	"signed_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "staff_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_member_id" integer NOT NULL,
	"credential_type" text NOT NULL,
	"credential_number" text,
	"expires_on" date
);

CREATE TABLE "staff_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"provider_id" integer,
	"name" text NOT NULL,
	"department" text NOT NULL,
	"title" text NOT NULL,
	"employment_status" "employment_status" DEFAULT 'active' NOT NULL,
	"hire_date" date NOT NULL,
	"termination_date" date
);

CREATE TABLE "tariff_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"scope" text NOT NULL,
	"department_id" integer,
	"payer_id" integer,
	"room_category_id" integer,
	"ward" text,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"deactivated_at" timestamp,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tariff_rates_amount_nonneg" CHECK ("tariff_rates"."amount_paise" >= 0),
	CONSTRAINT "tariff_rates_range_ordered" CHECK ("tariff_rates"."valid_to" IS NULL OR "tariff_rates"."valid_to" >= "tariff_rates"."valid_from"),
	CONSTRAINT "tariff_rates_scope_keys" CHECK (("tariff_rates"."scope" = 'base' AND "tariff_rates"."department_id" IS NULL AND "tariff_rates"."payer_id" IS NULL) OR ("tariff_rates"."scope" = 'department' AND "tariff_rates"."department_id" IS NOT NULL AND "tariff_rates"."payer_id" IS NULL) OR ("tariff_rates"."scope" = 'payer' AND "tariff_rates"."payer_id" IS NOT NULL AND "tariff_rates"."department_id" IS NULL))
);

CREATE TABLE "telemedicine_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"appointment_id" integer NOT NULL,
	"patient_join_token" text NOT NULL,
	"status" "telemedicine_session_status" DEFAULT 'scheduled' NOT NULL,
	"provider_joined_at" timestamp,
	"patient_joined_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telemedicine_sessions_appointment_id_unique" UNIQUE("appointment_id"),
	CONSTRAINT "telemedicine_sessions_patient_join_token_unique" UNIQUE("patient_join_token")
);

CREATE TABLE "telemedicine_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"sender" "telemedicine_signal_sender" NOT NULL,
	"signal_type" "telemedicine_signal_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "trials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"nct_number" text NOT NULL,
	"condition" text NOT NULL,
	"site" text NOT NULL,
	"study_drug" text NOT NULL,
	"age_min" integer NOT NULL,
	"age_max" integer NOT NULL,
	"diagnosis_codes" jsonb NOT NULL,
	"rating_scales" jsonb NOT NULL,
	"medication_classes" jsonb NOT NULL,
	"exclusion_diagnoses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_rating_scale_score" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL,
	"password_hash" text,
	"mfa_secret_encrypted" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_method" "mfa_method" DEFAULT 'totp' NOT NULL,
	"phone" text,
	"google_sub" text
);

ALTER TABLE "admission_transfers" ADD CONSTRAINT "admission_transfers_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admission_transfers" ADD CONSTRAINT "admission_transfers_from_room_id_rooms_id_fk" FOREIGN KEY ("from_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admission_transfers" ADD CONSTRAINT "admission_transfers_to_room_id_rooms_id_fk" FOREIGN KEY ("to_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_current_room_id_rooms_id_fk" FOREIGN KEY ("current_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_attending_provider_id_providers_id_fk" FOREIGN KEY ("attending_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_follow_up_appointment_id_appointments_id_fk" FOREIGN KEY ("follow_up_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_created_from_assignment_id_doctor_assignments_id_fk" FOREIGN KEY ("created_from_assignment_id") REFERENCES "public"."doctor_assignments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "adverse_events" ADD CONSTRAINT "adverse_events_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "adverse_events" ADD CONSTRAINT "adverse_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "allergies" ADD CONSTRAINT "allergies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_room_rent_service_id_service_catalog_id_fk" FOREIGN KEY ("room_rent_service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_preferred_provider_id_providers_id_fk" FOREIGN KEY ("preferred_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_resulting_appointment_id_appointments_id_fk" FOREIGN KEY ("resulting_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_filter_trial_id_trials_id_fk" FOREIGN KEY ("filter_trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "care_plan_goals" ADD CONSTRAINT "care_plan_goals_care_plan_id_care_plans_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plans"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_ordering_provider_id_providers_id_fk" FOREIGN KEY ("ordering_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_performing_provider_id_providers_id_fk" FOREIGN KEY ("performing_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_tariff_rate_id_tariff_rates_id_fk" FOREIGN KEY ("tariff_rate_id") REFERENCES "public"."tariff_rates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_legacy_charge_id_charges_id_fk" FOREIGN KEY ("legacy_charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_medication_dispense_id_medication_dispenses_id_fk" FOREIGN KEY ("medication_dispense_id") REFERENCES "public"."medication_dispenses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "charges" ADD CONSTRAINT "charges_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "codes" ADD CONSTRAINT "codes_code_system_id_code_systems_id_fk" FOREIGN KEY ("code_system_id") REFERENCES "public"."code_systems"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coding_queries" ADD CONSTRAINT "coding_queries_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coding_queries" ADD CONSTRAINT "coding_queries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coding_queries" ADD CONSTRAINT "coding_queries_addressed_to_provider_id_providers_id_fk" FOREIGN KEY ("addressed_to_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coding_queries" ADD CONSTRAINT "coding_queries_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coding_query_responses" ADD CONSTRAINT "coding_query_responses_query_fk" FOREIGN KEY ("query_id") REFERENCES "public"."coding_queries"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_code_id_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."codes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_lab_order_id_lab_orders_id_fk" FOREIGN KEY ("lab_order_id") REFERENCES "public"."lab_orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "drug_accountability_entries" ADD CONSTRAINT "drug_accountability_entries_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "drug_accountability_entries" ADD CONSTRAINT "drug_accountability_entries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_coding" ADD CONSTRAINT "encounter_coding_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_coding" ADD CONSTRAINT "encounter_coding_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_coding" ADD CONSTRAINT "encounter_coding_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_coding_events" ADD CONSTRAINT "encounter_coding_events_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_coding_events" ADD CONSTRAINT "encounter_coding_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_notes" ADD CONSTRAINT "encounter_notes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_notes" ADD CONSTRAINT "encounter_notes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_notes" ADD CONSTRAINT "encounter_notes_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_procedures" ADD CONSTRAINT "encounter_procedures_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_procedures" ADD CONSTRAINT "encounter_procedures_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_procedures" ADD CONSTRAINT "encounter_procedures_code_id_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."codes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_procedures" ADD CONSTRAINT "encounter_procedures_performed_by_provider_id_providers_id_fk" FOREIGN KEY ("performed_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounter_procedures" ADD CONSTRAINT "encounter_procedures_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_doctor_assignment_id_doctor_assignments_id_fk" FOREIGN KEY ("doctor_assignment_id") REFERENCES "public"."doctor_assignments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "faxes" ADD CONSTRAINT "faxes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_contact_attempts" ADD CONSTRAINT "follow_up_contact_attempts_attempted_by_user_id_users_id_fk" FOREIGN KEY ("attempted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_contact_attempts" ADD CONSTRAINT "follow_up_contact_attempts_order_id_fk" FOREIGN KEY ("follow_up_order_id") REFERENCES "public"."follow_up_orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_prescribed_by_provider_id_providers_id_fk" FOREIGN KEY ("prescribed_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_originating_encounter_id_encounters_id_fk" FOREIGN KEY ("originating_encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_originating_admission_id_admissions_id_fk" FOREIGN KEY ("originating_admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_originating_lab_order_id_lab_orders_id_fk" FOREIGN KEY ("originating_lab_order_id") REFERENCES "public"."lab_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_completed_encounter_id_encounters_id_fk" FOREIGN KEY ("completed_encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_orders" ADD CONSTRAINT "follow_up_orders_scheduled_by_user_id_users_id_fk" FOREIGN KEY ("scheduled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_chart_discrepancies" ADD CONSTRAINT "form_chart_discrepancies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_chart_discrepancies" ADD CONSTRAINT "form_chart_discrepancies_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_submission_consents" ADD CONSTRAINT "form_submission_consents_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_submission_consents" ADD CONSTRAINT "form_submission_consents_consent_document_id_consent_documents_id_fk" FOREIGN KEY ("consent_document_id") REFERENCES "public"."consent_documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_submission_scores" ADD CONSTRAINT "form_submission_scores_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_template_consents" ADD CONSTRAINT "form_template_consents_form_template_id_form_templates_id_fk" FOREIGN KEY ("form_template_id") REFERENCES "public"."form_templates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_template_consents" ADD CONSTRAINT "form_template_consents_consent_document_id_consent_documents_id_fk" FOREIGN KEY ("consent_document_id") REFERENCES "public"."consent_documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_folder_id_form_template_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."form_template_folders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "home_collection_visits" ADD CONSTRAINT "home_collection_visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "home_collection_visits" ADD CONSTRAINT "home_collection_visits_window_id_home_collection_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."home_collection_windows"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "home_collection_visits" ADD CONSTRAINT "home_collection_visits_collector_user_id_users_id_fk" FOREIGN KEY ("collector_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "home_collection_visits" ADD CONSTRAINT "home_collection_visits_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "home_collection_visits" ADD CONSTRAINT "home_collection_visits_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "insurance_eligibility_checks" ADD CONSTRAINT "insurance_eligibility_checks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "insurance_eligibility_checks" ADD CONSTRAINT "insurance_eligibility_checks_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_charge_line_id_charge_lines_id_fk" FOREIGN KEY ("charge_line_id") REFERENCES "public"."charge_lines"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_lab_test_id_lab_tests_id_fk" FOREIGN KEY ("lab_test_id") REFERENCES "public"."lab_tests"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_ordered_by_provider_id_providers_id_fk" FOREIGN KEY ("ordered_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_requisition_id_lab_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."lab_requisitions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_quoted_tariff_rate_id_tariff_rates_id_fk" FOREIGN KEY ("quoted_tariff_rate_id") REFERENCES "public"."tariff_rates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_visit_id_fk" FOREIGN KEY ("home_collection_visit_id") REFERENCES "public"."home_collection_visits"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_requisition_id_lab_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."lab_requisitions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_requisitions" ADD CONSTRAINT "lab_requisitions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_requisitions" ADD CONSTRAINT "lab_requisitions_ordered_by_provider_id_providers_id_fk" FOREIGN KEY ("ordered_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_requisitions" ADD CONSTRAINT "lab_requisitions_originating_encounter_id_encounters_id_fk" FOREIGN KEY ("originating_encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "lab_requisitions" ADD CONSTRAINT "lab_requisitions_follow_up_order_id_follow_up_orders_id_fk" FOREIGN KEY ("follow_up_order_id") REFERENCES "public"."follow_up_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "lab_requisitions" ADD CONSTRAINT "lab_requisitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lab_order_id_lab_orders_id_fk" FOREIGN KEY ("lab_order_id") REFERENCES "public"."lab_orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_resulted_by_user_id_users_id_fk" FOREIGN KEY ("resulted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_medication_episode_id_medication_episodes_id_fk" FOREIGN KEY ("medication_episode_id") REFERENCES "public"."medication_episodes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_medication_episode_id_medication_episodes_id_fk" FOREIGN KEY ("medication_episode_id") REFERENCES "public"."medication_episodes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_episodes" ADD CONSTRAINT "medication_episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_episodes" ADD CONSTRAINT "medication_episodes_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_episodes" ADD CONSTRAINT "medication_episodes_prescribed_by_provider_id_providers_id_fk" FOREIGN KEY ("prescribed_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_inventory" ADD CONSTRAINT "medication_inventory_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "messages" ADD CONSTRAINT "messages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mock_payments" ADD CONSTRAINT "mock_payments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mock_payments" ADD CONSTRAINT "mock_payments_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_aadhaar" ADD CONSTRAINT "patient_aadhaar_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_payments" ADD CONSTRAINT "patient_payments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_payments" ADD CONSTRAINT "patient_payments_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_payments" ADD CONSTRAINT "patient_payments_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_payments" ADD CONSTRAINT "patient_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_payments" ADD CONSTRAINT "patient_payments_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_statements" ADD CONSTRAINT "patient_statements_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_trial_screenings" ADD CONSTRAINT "patient_trial_screenings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patient_trial_screenings" ADD CONSTRAINT "patient_trial_screenings_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patients" ADD CONSTRAINT "patients_primary_payer_id_payers_id_fk" FOREIGN KEY ("primary_payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "patients" ADD CONSTRAINT "patients_secondary_payer_id_payers_id_fk" FOREIGN KEY ("secondary_payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "providers" ADD CONSTRAINT "providers_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_against_payment_id_patient_payments_id_fk" FOREIGN KEY ("against_payment_id") REFERENCES "public"."patient_payments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "regulatory_documents" ADD CONSTRAINT "regulatory_documents_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_occupied_by_patient_id_patients_id_fk" FOREIGN KEY ("occupied_by_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_room_category_id_room_categories_id_fk" FOREIGN KEY ("room_category_id") REFERENCES "public"."room_categories"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "screening_criteria_results" ADD CONSTRAINT "screening_criteria_results_screening_id_patient_trial_screenings_id_fk" FOREIGN KEY ("screening_id") REFERENCES "public"."patient_trial_screenings"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_package_items" ADD CONSTRAINT "service_package_items_package_service_id_service_catalog_id_fk" FOREIGN KEY ("package_service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_package_items" ADD CONSTRAINT "service_package_items_item_service_id_service_catalog_id_fk" FOREIGN KEY ("item_service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_procedure_codes" ADD CONSTRAINT "service_procedure_codes_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_room_category_id_room_categories_id_fk" FOREIGN KEY ("room_category_id") REFERENCES "public"."room_categories"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "telemedicine_sessions" ADD CONSTRAINT "telemedicine_sessions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "telemedicine_signals" ADD CONSTRAINT "telemedicine_signals_session_id_telemedicine_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telemedicine_sessions"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "charge_lines_patient_idx" ON "charge_lines" USING btree ("patient_id");
CREATE INDEX "charge_lines_encounter_idx" ON "charge_lines" USING btree ("encounter_id");
CREATE INDEX "charge_lines_admission_idx" ON "charge_lines" USING btree ("admission_id");
CREATE UNIQUE INDEX "charge_lines_room_rent_day_unique" ON "charge_lines" USING btree ("admission_id","service_date") WHERE source = 'room_rent' AND status <> 'void';
CREATE INDEX "charge_lines_invoice_idx" ON "charge_lines" USING btree ("invoice_id");
CREATE UNIQUE INDEX "code_systems_kind_version_unique" ON "code_systems" USING btree ("kind","version");
CREATE UNIQUE INDEX "code_systems_one_current_per_kind" ON "code_systems" USING btree ("kind") WHERE "code_systems"."is_current";
CREATE UNIQUE INDEX "codes_system_code_unique" ON "codes" USING btree ("code_system_id","code");
CREATE INDEX "codes_code_prefix_idx" ON "codes" USING btree ("code_system_id","code" text_pattern_ops);
CREATE INDEX "coding_queries_encounter_idx" ON "coding_queries" USING btree ("encounter_id");
CREATE INDEX "coding_queries_provider_status_idx" ON "coding_queries" USING btree ("addressed_to_provider_id","status");
CREATE INDEX "coding_query_responses_query_idx" ON "coding_query_responses" USING btree ("query_id");
CREATE INDEX "diagnoses_encounter_id_idx" ON "diagnoses" USING btree ("encounter_id");
CREATE UNIQUE INDEX "diagnoses_one_primary_per_encounter" ON "diagnoses" USING btree ("encounter_id") WHERE "diagnoses"."diagnosis_type" = 'primary' AND "diagnoses"."voided_at" IS NULL;
CREATE INDEX "encounter_coding_status_idx" ON "encounter_coding" USING btree ("status");
CREATE INDEX "encounter_coding_assignee_idx" ON "encounter_coding" USING btree ("assigned_to_user_id");
CREATE INDEX "encounter_coding_events_encounter_idx" ON "encounter_coding_events" USING btree ("encounter_id");
CREATE INDEX "encounter_coding_events_at_idx" ON "encounter_coding_events" USING btree ("at");
CREATE INDEX "encounter_procedures_encounter_id_idx" ON "encounter_procedures" USING btree ("encounter_id");
CREATE INDEX "encounter_procedures_patient_id_idx" ON "encounter_procedures" USING btree ("patient_id");
CREATE UNIQUE INDEX "encounters_date_token_unique" ON "encounters" USING btree ("encounter_date","opd_token");
CREATE INDEX "encounters_patient_id_idx" ON "encounters" USING btree ("patient_id");
CREATE INDEX "follow_up_contact_attempts_order_idx" ON "follow_up_contact_attempts" USING btree ("follow_up_order_id");
CREATE INDEX "follow_up_orders_patient_id_idx" ON "follow_up_orders" USING btree ("patient_id");
CREATE INDEX "follow_up_orders_status_window_idx" ON "follow_up_orders" USING btree ("status","window_end");
CREATE UNIQUE INDEX "form_template_consents_template_document_unique" ON "form_template_consents" USING btree ("form_template_id","consent_document_id");
CREATE UNIQUE INDEX "home_collection_visits_patient_slot_unique" ON "home_collection_visits" USING btree ("patient_id","visit_date","window_id") WHERE status = 'booked';
CREATE INDEX "home_collection_visits_date_window_idx" ON "home_collection_visits" USING btree ("visit_date","window_id");
CREATE INDEX "home_collection_visits_collector_date_idx" ON "home_collection_visits" USING btree ("collector_user_id","visit_date");
CREATE UNIQUE INDEX "invoice_lines_invoice_line_no_unique" ON "invoice_lines" USING btree ("invoice_id","line_no");
CREATE INDEX "invoices_patient_idx" ON "invoices" USING btree ("patient_id");
CREATE UNIQUE INDEX "lab_orders_sample_date_seq_unique" ON "lab_orders" USING btree ("sample_date","sample_seq");
CREATE INDEX "lab_orders_requisition_idx" ON "lab_orders" USING btree ("requisition_id");
CREATE INDEX "lab_orders_visit_idx" ON "lab_orders" USING btree ("home_collection_visit_id");
CREATE INDEX "lab_orders_status_idx" ON "lab_orders" USING btree ("status");
CREATE UNIQUE INDEX "lab_reports_requisition_version_unique" ON "lab_reports" USING btree ("requisition_id","version");
CREATE INDEX "lab_reports_patient_idx" ON "lab_reports" USING btree ("patient_id");
CREATE INDEX "lab_requisitions_patient_idx" ON "lab_requisitions" USING btree ("patient_id");
CREATE INDEX "notification_deliveries_patient_idx" ON "notification_deliveries" USING btree ("patient_id");
CREATE INDEX "notification_deliveries_related_idx" ON "notification_deliveries" USING btree ("related_type","related_id");
CREATE INDEX "patient_contacts_patient_id_idx" ON "patient_contacts" USING btree ("patient_id");
CREATE INDEX "patient_payments_patient_idx" ON "patient_payments" USING btree ("patient_id");
CREATE INDEX "refunds_patient_idx" ON "refunds" USING btree ("patient_id");
CREATE INDEX "service_catalog_department_idx" ON "service_catalog" USING btree ("department_id");
CREATE UNIQUE INDEX "service_package_items_pkg_item_unique" ON "service_package_items" USING btree ("package_service_id","item_service_id");
CREATE UNIQUE INDEX "service_procedure_codes_unique" ON "service_procedure_codes" USING btree ("service_id","code_system_kind","code");
CREATE UNIQUE INDEX "service_procedure_codes_one_primary" ON "service_procedure_codes" USING btree ("service_id") WHERE "service_procedure_codes"."is_primary";
CREATE INDEX "tariff_rates_service_idx" ON "tariff_rates" USING btree ("service_id");
