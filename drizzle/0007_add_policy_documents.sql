ALTER TYPE "public"."signable_type" ADD VALUE IF NOT EXISTS 'policy_acceptance';
ALTER TABLE "signatures" ADD COLUMN IF NOT EXISTS "patient_id" text REFERENCES "patients"("id");
CREATE TYPE "public"."policy_document_type" AS ENUM('npp', 'tos');
CREATE TABLE IF NOT EXISTS "policy_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "policy_document_type" NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"is_draft" boolean DEFAULT true NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
