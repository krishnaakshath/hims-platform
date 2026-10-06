CREATE TYPE "public"."admission_status" AS ENUM('admitted', 'discharged');--> statement-breakpoint
CREATE TYPE "public"."admission_type" AS ENUM('elective', 'emergency', 'transfer_in');--> statement-breakpoint
CREATE TYPE "public"."booking_request_status" AS ENUM('pending', 'confirmed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."care_plan_goal_status" AS ENUM('active', 'met', 'not_met', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."care_plan_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."doctor_assignment_status" AS ENUM('pending', 'scheduled', 'declined');--> statement-breakpoint
CREATE TYPE "public"."doctor_assignment_urgency" AS ENUM('routine', 'urgent', 'emergency');--> statement-breakpoint
CREATE TYPE "public"."doctor_assignment_visit_type" AS ENUM('inpatient', 'outpatient');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('other', 'drivers_license', 'legal_document', 'insurance_card_primary_front', 'insurance_card_primary_back', 'insurance_card_secondary_front', 'insurance_card_secondary_back', 'insurance_eob', 'insurance_authorization', 'imaging_result');--> statement-breakpoint
CREATE TYPE "public"."eligibility_status" AS ENUM('verified', 'inactive', 'needs_follow_up');--> statement-breakpoint
CREATE TYPE "public"."employment_status" AS ENUM('active', 'on_leave', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."insurance_plan_type" AS ENUM('ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid');--> statement-breakpoint
CREATE TYPE "public"."insurance_relationship" AS ENUM('self', 'spouse', 'child', 'other');--> statement-breakpoint
CREATE TYPE "public"."lab_order_status" AS ENUM('ordered', 'collected', 'resulted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lab_result_flag" AS ENUM('normal', 'abnormal', 'critical');--> statement-breakpoint
CREATE TYPE "public"."lab_test_category" AS ENUM('lab', 'imaging');--> statement-breakpoint
CREATE TYPE "public"."mar_status" AS ENUM('scheduled', 'given', 'held', 'refused');--> statement-breakpoint
CREATE TYPE "public"."medication_form" AS ENUM('tablet', 'capsule', 'liquid', 'injection', 'other');--> statement-breakpoint
CREATE TYPE "public"."mfa_method" AS ENUM('totp', 'sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."note_status" AS ENUM('draft', 'signed');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('progress', 'nursing', 'intake');--> statement-breakpoint
CREATE TYPE "public"."payer_type" AS ENUM('commercial', 'medicare', 'medicaid', 'tricare', 'other');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('available', 'occupied', 'dirty', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."signable_type" AS ENUM('form_submission', 'admission_discharge');--> statement-breakpoint
CREATE TYPE "public"."telemedicine_session_status" AS ENUM('scheduled', 'waiting', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."telemedicine_signal_sender" AS ENUM('provider', 'patient');--> statement-breakpoint
CREATE TYPE "public"."telemedicine_signal_type" AS ENUM('offer', 'answer', 'ice_candidate');--> statement-breakpoint
ALTER TYPE "public"."id_type" ADD VALUE 'military_id';--> statement-breakpoint
ALTER TYPE "public"."id_type" ADD VALUE 'green_card';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'frontdesk';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'pharmacy';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'billing';--> statement-breakpoint
CREATE TABLE "admission_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"admission_id" integer NOT NULL,
	"from_room_id" integer,
	"to_room_id" integer NOT NULL,
	"reason" text NOT NULL,
	"transferred_by_name" text NOT NULL,
	"transferred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "care_plan_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"care_plan_id" integer NOT NULL,
	"description" text NOT NULL,
	"target_date" date,
	"status" "care_plan_goal_status" DEFAULT 'active' NOT NULL,
	"status_updated_at" timestamp,
	"status_updated_by_name" text
);
--> statement-breakpoint
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
--> statement-breakpoint
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
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "form_submission_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_submission_id" integer NOT NULL,
	"total_score" integer NOT NULL,
	"band_label" text NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "form_submission_scores_form_submission_id_unique" UNIQUE("form_submission_id")
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "lab_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"lab_test_id" integer NOT NULL,
	"ordered_by_provider_id" integer NOT NULL,
	"status" "lab_order_status" DEFAULT 'ordered' NOT NULL,
	"ordered_at" timestamp DEFAULT now() NOT NULL,
	"collected_at" timestamp
);
--> statement-breakpoint
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
	CONSTRAINT "lab_results_lab_order_id_unique" UNIQUE("lab_order_id")
);
--> statement-breakpoint
CREATE TABLE "lab_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"category" "lab_test_category" DEFAULT 'lab' NOT NULL,
	"default_unit" text,
	"reference_range" text
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "medication_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"medication_id" integer NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 10 NOT NULL,
	"unit" text DEFAULT 'units' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "medication_inventory_medication_id_unique" UNIQUE("medication_id")
);
--> statement-breakpoint
CREATE TABLE "medications" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"medication_class" text NOT NULL,
	"common_dose" text,
	"form" "medication_form" DEFAULT 'tablet' NOT NULL,
	CONSTRAINT "medications_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"sender_role" text NOT NULL,
	"sender_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_by_patient_at" timestamp,
	"read_by_provider_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "payers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payer_id" text NOT NULL,
	"payer_type" "payer_type" DEFAULT 'commercial' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"ward" text NOT NULL,
	"room_number" text NOT NULL,
	"bed_number" text NOT NULL,
	"status" "room_status" DEFAULT 'available' NOT NULL,
	"blocked_reason" text,
	"occupied_by_patient_id" text
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" serial PRIMARY KEY NOT NULL,
	"signable_type" "signable_type" NOT NULL,
	"signable_id" integer NOT NULL,
	"signer_typed_name" text NOT NULL,
	"signer_role" text NOT NULL,
	"attestation_text" text NOT NULL,
	"signed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_member_id" integer NOT NULL,
	"credential_type" text NOT NULL,
	"credential_number" text,
	"expires_on" date
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "telemedicine_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"sender" "telemedicine_signal_sender" NOT NULL,
	"signal_type" "telemedicine_signal_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_matches" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "identity_matches" CASCADE;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "practice_name" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "practice_site" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "practice_timezone" text DEFAULT 'America/Los_Angeles';--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "admin_mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "admin_mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "admin_mfa_method" "mfa_method" DEFAULT 'totp' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "admin_phone" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "queue_display_pin" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "document_type" "document_type" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "admission_id" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "lab_order_id" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "file_url" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "filed_by_name" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "filed_at" timestamp;--> statement-breakpoint
ALTER TABLE "form_templates" ADD COLUMN "scoring_rule" jsonb;--> statement-breakpoint
ALTER TABLE "insurance_claims" ADD COLUMN "payer_id" integer;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "medication_id" integer;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "frequency_per_day" integer;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "prescribed_by_provider_id" integer;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "entered_by_name" text;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD COLUMN "prescribed_at" timestamp;--> statement-breakpoint
ALTER TABLE "patient_trial_screenings" ADD COLUMN "selection_confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "patient_trial_screenings" ADD COLUMN "selection_confirmed_by_name" text;--> statement-breakpoint
ALTER TABLE "patient_trial_screenings" ADD COLUMN "selection_notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "dob" date NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "zip" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "portal_password_hash" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_payer_id" integer;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_member_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_group_number" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_plan_type" "insurance_plan_type";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_subscriber_name" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_subscriber_relationship" "insurance_relationship";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_card_front_url" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "primary_card_back_url" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "secondary_payer_id" integer;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "secondary_member_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "secondary_group_number" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "secondary_plan_type" "insurance_plan_type";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "secondary_subscriber_name" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "secondary_subscriber_relationship" "insurance_relationship";--> statement-breakpoint
ALTER TABLE "screening_criteria_results" ADD COLUMN "criterion_type" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "exclusion_diagnoses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "min_rating_scale_score" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_method" "mfa_method" DEFAULT 'totp' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "admission_transfers" ADD CONSTRAINT "admission_transfers_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_transfers" ADD CONSTRAINT "admission_transfers_from_room_id_rooms_id_fk" FOREIGN KEY ("from_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_transfers" ADD CONSTRAINT "admission_transfers_to_room_id_rooms_id_fk" FOREIGN KEY ("to_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_current_room_id_rooms_id_fk" FOREIGN KEY ("current_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_attending_provider_id_providers_id_fk" FOREIGN KEY ("attending_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_follow_up_appointment_id_appointments_id_fk" FOREIGN KEY ("follow_up_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_created_from_assignment_id_doctor_assignments_id_fk" FOREIGN KEY ("created_from_assignment_id") REFERENCES "public"."doctor_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_preferred_provider_id_providers_id_fk" FOREIGN KEY ("preferred_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_resulting_appointment_id_appointments_id_fk" FOREIGN KEY ("resulting_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_goals" ADD CONSTRAINT "care_plan_goals_care_plan_id_care_plans_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_assignments" ADD CONSTRAINT "doctor_assignments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_notes" ADD CONSTRAINT "encounter_notes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_notes" ADD CONSTRAINT "encounter_notes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_notes" ADD CONSTRAINT "encounter_notes_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_chart_discrepancies" ADD CONSTRAINT "form_chart_discrepancies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_chart_discrepancies" ADD CONSTRAINT "form_chart_discrepancies_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission_scores" ADD CONSTRAINT "form_submission_scores_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_eligibility_checks" ADD CONSTRAINT "insurance_eligibility_checks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_eligibility_checks" ADD CONSTRAINT "insurance_eligibility_checks_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_lab_test_id_lab_tests_id_fk" FOREIGN KEY ("lab_test_id") REFERENCES "public"."lab_tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_ordered_by_provider_id_providers_id_fk" FOREIGN KEY ("ordered_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lab_order_id_lab_orders_id_fk" FOREIGN KEY ("lab_order_id") REFERENCES "public"."lab_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_medication_episode_id_medication_episodes_id_fk" FOREIGN KEY ("medication_episode_id") REFERENCES "public"."medication_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_medication_episode_id_medication_episodes_id_fk" FOREIGN KEY ("medication_episode_id") REFERENCES "public"."medication_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_inventory" ADD CONSTRAINT "medication_inventory_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_occupied_by_patient_id_patients_id_fk" FOREIGN KEY ("occupied_by_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemedicine_sessions" ADD CONSTRAINT "telemedicine_sessions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemedicine_signals" ADD CONSTRAINT "telemedicine_signals_session_id_telemedicine_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telemedicine_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_lab_order_id_lab_orders_id_fk" FOREIGN KEY ("lab_order_id") REFERENCES "public"."lab_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD CONSTRAINT "medication_episodes_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD CONSTRAINT "medication_episodes_prescribed_by_provider_id_providers_id_fk" FOREIGN KEY ("prescribed_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_primary_payer_id_payers_id_fk" FOREIGN KEY ("primary_payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_secondary_payer_id_payers_id_fk" FOREIGN KEY ("secondary_payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "intakeq_client_id_encrypted";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "tebra_patient_id_encrypted";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "name_intakeq";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "name_tebra";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "dob_intakeq";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "dob_tebra";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "city_intakeq";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "city_tebra";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "zip_intakeq";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "zip_tebra";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "phone_intakeq";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "phone_tebra";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "email_intakeq";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "email_tebra";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "tebra_chart_url";--> statement-breakpoint
DROP TYPE "public"."document_label";--> statement-breakpoint
DROP TYPE "public"."match_status";