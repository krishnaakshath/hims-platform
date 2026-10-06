CREATE TYPE "public"."document_label" AS ENUM('other', 'drivers_license', 'legal_document');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('new', 'processed');--> statement-breakpoint
CREATE TYPE "public"."fax_delivery_status" AS ENUM('delivered', 'failed');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"document_date" date NOT NULL,
	"status" "document_status" DEFAULT 'new' NOT NULL,
	"received_from" text NOT NULL,
	"label" "document_label" DEFAULT 'other' NOT NULL,
	"patient_id" text,
	"file_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faxes" ADD CONSTRAINT "faxes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;