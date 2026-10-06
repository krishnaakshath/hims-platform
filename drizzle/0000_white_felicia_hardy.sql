CREATE TYPE "public"."match_status" AS ENUM('pending', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('crc', 'pi', 'admin');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('green', 'yellow', 'red');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_name" text NOT NULL,
	"role" "role" NOT NULL,
	"action" text NOT NULL,
	"patient_id" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"details" text
);
--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"date" date
);
--> statement-breakpoint
CREATE TABLE "identity_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"intakeq_client_id_encrypted" text NOT NULL,
	"referral_name" text NOT NULL,
	"referral_dob" date NOT NULL,
	"candidate_tebra_patient_id_encrypted" text NOT NULL,
	"candidate_name" text NOT NULL,
	"candidate_dob" date NOT NULL,
	"confidence" integer NOT NULL,
	"status" "match_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"name" text NOT NULL,
	"medication_class" text NOT NULL,
	"dose" text,
	"start_date" date NOT NULL,
	"stop_date" date,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_trial_screenings" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"trial_id" text NOT NULL,
	"overall_status" "verdict" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"date_added" timestamp DEFAULT now() NOT NULL,
	"intakeq_client_id_encrypted" text NOT NULL,
	"tebra_patient_id_encrypted" text,
	"name_intakeq" text NOT NULL,
	"name_tebra" text,
	"dob_intakeq" date NOT NULL,
	"dob_tebra" date,
	"city_intakeq" text,
	"city_tebra" text,
	"zip_intakeq" text,
	"zip_tebra" text,
	"phone_intakeq" text,
	"phone_tebra" text,
	"email_intakeq" text,
	"email_tebra" text,
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
	"tebra_chart_url" text,
	"last_communication" text,
	"form_notes" text,
	"reviewer_notes" text,
	"clinician_reviewer_notes" text,
	"pi_recommendation" text,
	"old_notes" text,
	"old_recs" text,
	"outside_meds_confirmation" text,
	"chart_data_as_of" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screening_criteria_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"screening_id" integer NOT NULL,
	"criterion_key" text NOT NULL,
	"criterion_text" text NOT NULL,
	"verdict" "verdict" NOT NULL,
	"evidence_quote" text,
	"evidence_source_doc" text,
	"evidence_source_date" date
);
--> statement-breakpoint
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
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_episodes" ADD CONSTRAINT "medication_episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_trial_screenings" ADD CONSTRAINT "patient_trial_screenings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_trial_screenings" ADD CONSTRAINT "patient_trial_screenings_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_criteria_results" ADD CONSTRAINT "screening_criteria_results_screening_id_patient_trial_screenings_id_fk" FOREIGN KEY ("screening_id") REFERENCES "public"."patient_trial_screenings"("id") ON DELETE no action ON UPDATE no action;