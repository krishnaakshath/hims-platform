CREATE TYPE "public"."broadcast_channel" AS ENUM('sms', 'email', 'both');--> statement-breakpoint
CREATE TYPE "public"."broadcast_form_status_filter" AS ENUM('sent', 'partial', 'completed', 'none');--> statement-breakpoint
CREATE TYPE "public"."survey_status" AS ENUM('sent', 'completed');--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_filter_trial_id_trials_id_fk" FOREIGN KEY ("filter_trial_id") REFERENCES "public"."trials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE no action ON UPDATE no action;