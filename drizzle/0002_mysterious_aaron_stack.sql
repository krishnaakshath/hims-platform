CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('draft', 'pending_approval', 'approved', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."insurance_claim_status" AS ENUM('rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid');--> statement-breakpoint
CREATE TYPE "public"."mock_payment_result" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."statement_delivery_method" AS ENUM('email', 'sms', 'paper');--> statement-breakpoint
CREATE TYPE "public"."statement_delivery_status" AS ENUM('delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."statement_type" AS ENUM('initial', 'reminder', 'final_notice');--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "insurance_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"charge_id" integer NOT NULL,
	"patient_id" text NOT NULL,
	"payer_name" text NOT NULL,
	"billed_amount_cents" integer NOT NULL,
	"paid_amount_cents" integer,
	"status" "insurance_claim_status" NOT NULL,
	"submitted_date" date NOT NULL,
	"notes" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "patient_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"delivery_method" "statement_delivery_method" NOT NULL,
	"type" "statement_type" NOT NULL,
	"delivery_status" "statement_delivery_status" NOT NULL,
	"sent_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"credentials" text,
	"specialty" text NOT NULL,
	"color_tag" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_payments" ADD CONSTRAINT "mock_payments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_payments" ADD CONSTRAINT "mock_payments_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_statements" ADD CONSTRAINT "patient_statements_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_access_token_unique" UNIQUE("access_token");