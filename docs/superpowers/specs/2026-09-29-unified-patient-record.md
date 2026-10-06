# Unified Patient Record — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** the foundational item in the next "make HIMS the real product" wave — almost every other spec in this wave (Medical Record redesign, Forms Hub redesign, and several others) either depends on this landing first or references patient fields this spec changes. This is deliberately the first plan executed from this wave, on `hims-platform` only (not `master`/production — the two branches are kept intentionally separate per standing instruction).

## 1. What this is, and the boundary it works within

Clinsync was originally built as a **reconciliation tool** between two upstream systems it never actually integrated with: "Tebra" (a clinical EHR) and "IntakeQ" (an intake/referral tool), both simulated by in-memory mock connectors (`src/connectors/tebra.mock.ts`, `src/connectors/intakeq.mock.ts`) that were never wired to a real API. That origin shows up everywhere: the `patients` table stores most demographic fields as a *pair* of columns (`nameIntakeq`/`nameTebra`, `dobIntakeq`/`dobTebra`, etc.), a dedicated "Identity Matching" screen exists to decide whether a new intake referral is the same person as an existing clinical-record patient, a "Dual-Sourced Fields" comparison table sits at the top of every patient's medical record showing both values side by side and flagging mismatches, and a whole Settings tab lets an admin paste Tebra/IntakeQ API credentials that nothing in the codebase has ever actually called.

Clinsync is no longer a reconciliation layer sitting in front of two other systems — it **is** the system of record. This spec collapses the dual-sourced data model into a single, ordinary patient record (one `name`, one `dob`, one `email`, etc.), and removes every feature whose entire premise was reconciling two systems that don't exist for this product: the Identity Matching screen, the EHR sync engine, the mock connectors, and the EHR Connections settings tab. Nothing in this spec's own words ever says "Tebra" or "IntakeQ" — new field names, new UI copy, new code comments all describe what the data *is*, not which of two retired mock systems it used to come from.

**Explicitly out of scope:**
- Any change to `master`/production. This migration runs on `hims-platform` only.
- Building a real integration with any actual third-party EHR or intake vendor. This spec removes the simulated integration; it does not replace it with a real one. If Clinsync ever needs to import data from a real external system, that's a new, separately-scoped spec with a real vendor contract behind it (matching this codebase's own established discipline elsewhere of never simulating a vendor integration it doesn't actually have).
- Re-architecting how a brand-new patient enters the system. The existing "Add Client" flow (`POST /api/patients`, staff-initiated) and the existing intake-token self-service form flow (`src/lib/queries/intake-portal.ts`, requires an already-created patient row) both already work as a single-sourced product would want them to; this spec fixes the one place Add Client still round-trips through a mock Tebra write (see §3), but does not add a new patient-creation flow.
- Redesigning the Medical Record page's layout. This spec removes the old "Dual-Sourced Fields" comparison table from that page (its entire reason for existing goes away), but the broader visual redesign of that page is a separate spec (`2026-09-29-medical-record-redesign.md` or similar), sequenced to start after this one merges.

## 2. Data model changes

### 2.1 `patients` table — collapse dual-sourced pairs into single fields

```ts
// Before (six dual-sourced pairs):
nameIntakeq: text('name_intakeq').notNull()
nameTebra: text('name_tebra')
dobIntakeq: date('dob_intakeq').notNull()
dobTebra: date('dob_tebra')
cityIntakeq: text('city_intakeq')
cityTebra: text('city_tebra')
zipIntakeq: text('zip_intakeq')
zipTebra: text('zip_tebra')
phoneIntakeq: text('phone_intakeq')
phoneTebra: text('phone_tebra')
emailIntakeq: text('email_intakeq')
emailTebra: text('email_tebra')

// After (one field each, same nullability as the pair's NOT NULL member):
name: text('name').notNull()
dob: date('dob').notNull()
city: text('city')
zip: text('zip')
phone: text('phone')
email: text('email')
```

Backfill rule for existing rows (the migration script's job, not a runtime fallback): `name = nameTebra ?? nameIntakeq`, `dob = dobTebra ?? dobIntakeq`, and likewise for city/zip/phone/email — i.e., preserve exactly the same "Tebra wins if present" precedence every read path in the app already uses today (`patient.nameTebra ?? patient.nameIntakeq`), so no patient's *displayed* value changes as a result of this migration. After backfill, the six old columns are dropped.

Also removed from `patients` entirely (no replacement — dead once there's no second system to link against):
- `intakeqClientIdRef` (`intakeq_client_id_encrypted` column) — a pseudonymous cross-system linkage id, `ENC[...]`-wrapped.
- `tebraPatientIdRef` — the same, for the Tebra side.
- `tebraChartUrl` — a "link to the external EHR chart" field with nothing to link to anymore.

Kept, unchanged (real fields, not tied to which mock system they used to come from — see §2.4 for the one behavior change on `currentProvider`):
- `referralType`, `availability`, `commConsentSigned`, `commConsentPref`, `ratingScales`, `prescreeningSentDate`, `templateDocUrl`, `currentProvider`, and every field the original schema comment already called out as staff-owned and untouched by any sync (`portalPasswordHash`, `formNotes`, `reviewerNotes`, `clinicianReviewerNotes`, `piRecommendation`, `oldNotes`, `oldRecs`, `outsideMedsConfirmation`, `chartDataAsOf`, `mfaSecretEncrypted`, `mfaEnabled`, all `primary*`/`secondary*` insurance fields, `id`, `dateAdded`, `lastApptDate`, `nextApptDate`).

### 2.2 `diagnoses.source` column — removed

`source: text('source', { enum: ['tebra', 'intakeq'] }).notNull()` is dropped. Every write path that has ever populated it wrote the literal string `'tebra'` (the `'intakeq'` value is schema-level-possible but never exercised in code — confirmed by reading every insert site), and no UI reads it today (the one component built to display it, `SourceTag.tsx`, has zero importers anywhere in the codebase — dead code, deleted in §2.6). A diagnosis in the new model is just a diagnosis; nothing in the product needs to know which retired mock system it notionally came from.

### 2.3 `identityMatches` table and `matchStatusEnum` — dropped entirely

The table, its enum, and every row in it are removed. There is no longer a concept of "an intake referral that might be the same person as an existing clinical-record patient" — a new patient is either a brand-new person (Add Client) or an existing one a staff member already knows about; there is no second system's record to reconcile against.

### 2.4 `appSettings` — EHR Connections fields removed

`intakeqApiKeyEncrypted`, `tebraCustomerKeyEncrypted`, `tebraUserEncrypted`, `tebraPasswordEncrypted` columns are dropped, along with the `intakeqConfigured`/`tebraConfigured` computed booleans in `getSettingsSummary()`. These fields stored real AES-256-GCM-encrypted values, but the Settings page's own existing copy already says outright that "nothing in this app calls either API today" — no code path has ever read them to make an outbound call. Removing them removes a feature that never did anything.

## 3. Behavior changes beyond the schema

**Add Client (`POST /api/patients`) stops writing to the mock Tebra connector.** Today this route calls `tebra.createPatient(...)` purely to mint a `tebraPatientId` so the dual-column schema has something to put in the Tebra-labeled fields, and mirrors the same single value it received into both the Tebra- and IntakeQ-labeled columns (a real "we only have one value, force it into two columns" workaround, visible in the route's own existing comments). After this migration, Add Client does exactly what it looks like it should do: validates the input, inserts one `patients` row with the single-sourced fields from §2.1, done. No connector call, no dual-write. `currentProvider` (previously populated only from a Tebra pull) becomes a plain optional field staff can set directly on Add Client or edit afterward, same access pattern as any other patient field.

**The Medical Record page's "Dual-Sourced Fields" comparison table is removed.** That section (`ComparisonRow` components showing Intake Form / Clinical Record / Merged values, flagging a mismatch highlight when they differ) has no meaning once there's one field, not two — it's deleted as part of this migration, not deferred to the separate Medical Record redesign spec, since leaving a comparison table with nothing to compare would be a visibly broken page in the interim.

**The Workbook export and the in-app Workbook table lose their Name/DOB Match-vs-Mismatch columns.** `src/lib/excel-export.ts` and `src/lib/queries/workbook.ts` currently carry both field pairs specifically to compute and flag a mismatch; both become single-field, matching every other column in that grid. `WorkbookTable.tsx`'s column labels are already genericized today (e.g. "Intake Email", not "IntakeQ Email") — this spec finishes that work by making the underlying data single-valued too, and drops the two Match columns since there's nothing left for them to compare.

**FHIR mapping** (`src/lib/fhir/patient.ts`) drops its `dobTebra ?? dobIntakeq` fallback in favor of reading `patient.dob` directly — a pure simplification, same exported value for every existing patient.

## 4. What's deleted outright (not migrated, not renamed — removed)

These exist *only* to support the two-system reconciliation model and have no place in a single-source product:

- **The Identity Matching screen and its backing code**: `src/app/(dashboard)/identity-matching/` (page + loading state), `src/app/api/identity-matches/[id]/confirm/route.ts` and `.../reject/route.ts`, `src/lib/queries/identity-matches.ts`, `src/lib/matcher.ts` (the Levenshtein-based name-confidence scorer that only ever fed this screen). Its nav entry in `LeftNav.tsx` and its bullets in `role-capabilities.ts` (admin/crc: "resolves identity matches") are removed too.
- **The EHR sync engine**: `src/lib/ehr-sync.ts` in full — `syncFromEhrs()` (the pull-from-both-mocks-and-queue-a-match job; confirmed to have no caller anywhere in the app today, i.e. this is already-dormant infrastructure) and `confirmIdentityMatch()` (the function the Identity Matching screen's Confirm button calls, which is what actually created a merged dual-sourced patient row — removed along with the screen that called it).
- **The mock connectors**: `src/connectors/intakeq.mock.ts`, `src/connectors/tebra.mock.ts`, `src/connectors/types.ts` in full.
- **The EHR Connections settings tab**: `src/components/EhrConnectionsForm.tsx`, `src/app/api/settings/ehr-connections/route.ts`, and the tab's entry in `src/app/(dashboard)/settings/page.tsx`.
- **`SourceTag.tsx`** — confirmed zero importers anywhere in `src/`, dead code predating even this migration.
- **The "refresh from source systems" action** on a patient (`src/app/api/patients/[anonId]/refresh/route.ts`) — its entire job was re-pulling Tebra/IntakeQ data; with no second system, there's nothing to refresh from. If a patient's staff-entered details need correcting, that's an ordinary edit, not a "refresh" action. (Confirm during implementation whether this route has a UI entry point calling it — remove that too if so.)

## 5. Migration mechanics

This is a live, shared Neon Postgres database with real seeded data and no per-branch isolation (standing constraint for this whole project). The migration script (hand-written, run once, verified against `information_schema` afterward — this repo's established convention, never `drizzle-kit push`) must, in order:

1. Add the six new single-value columns (`name`, `dob`, `city`, `zip`, `phone`, `email`) as nullable.
2. Backfill every existing row: `name = COALESCE(name_tebra, name_intakeq)`, `dob = COALESCE(dob_tebra, dob_intakeq)`, and the same pattern for city/zip/phone/email.
3. Set `name`/`dob` `NOT NULL` (matching their pre-migration `*Intakeq` counterparts' constraint) now that every row has a value.
4. Drop the twelve old columns (`nameIntakeq`, `nameTebra`, `dobIntakeq`, `dobTebra`, `cityIntakeq`, `cityTebra`, `zipIntakeq`, `zipTebra`, `phoneIntakeq`, `phoneTebra`, `emailIntakeq`, `emailTebra`), plus `intakeq_client_id_encrypted`, `tebra_patient_id_encrypted`, `tebra_chart_url`.
5. Drop the `diagnoses.source` column.
6. Drop the `identity_matches` table and the `match_status` enum.
7. Drop the four EHR-credential columns on `app_settings`.

Every step is a plain `ALTER TABLE`/`DROP` against real column/table names confirmed live via `information_schema` before the drop, not a speculative rename. Because this drops columns (unlike this project's usual additive-only migrations), it must run once, be verified immediately afterward with a live `SELECT` against a handful of real patient rows confirming `name`/`dob` match what `nameTebra ?? nameIntakeq` / `dobTebra ?? dobIntakeq` would have produced, and the plan should sequence this as its own first task, blocking every other task in the plan until it's confirmed correct — every other task edits code that assumes the new columns already exist.

`src/db/seed.ts` is rewritten in the same pass: every seeded patient gets one `name`/`dob`/etc. instead of a mirrored pair, the six hardcoded `identityMatches` seed rows are deleted, and `intakeqClientIdRef`/`tebraPatientIdRef` seed values disappear along with the columns.

## 6. Testing

- A migration-correctness test (or a one-time verification script, per this repo's established pattern for schema changes) confirming, against the live shared DB, that every patient's new `name`/`dob` equals what the old `nameTebra ?? nameIntakeq` / `dobTebra ?? dobIntakeq` logic would have produced — this is the one guarantee this whole migration exists to make (no patient's displayed identity silently changes).
- Every existing test file that references the old dual-sourced field names, `identityMatches`, `ehr-sync.ts`, or the mock connectors needs updating or removing (a full-repo grep for `nameTebra|nameIntakeq|dobTebra|dobIntakeq|cityTebra|cityIntakeq|zipTebra|zipIntakeq|phoneTebra|phoneIntakeq|emailTebra|emailIntakeq|tebraPatientIdRef|intakeqClientIdRef|tebraChartUrl|identityMatches|ehr-sync|tebra.mock|intakeq.mock` in `tests/` is the actual scope-sizing step for this — expect this to be the largest single chunk of file-touching in the whole plan).
- `tests/api/patients-create.test.ts` (or wherever Add Client is tested) needs a new/updated assertion that the created row has single-valued fields and never calls into a Tebra mock (the mock file no longer exists, so this is enforced by the code simply not compiling if a stray reference survives).
- The Workbook export test (if one exists) drops its Match/Mismatch column assertions.

## 7. Role gating summary

No role-gating changes. This spec removes features (Identity Matching, EHR Connections settings) rather than adding gated ones; removing a page also removes its nav entry and role-capabilities bullets (see §4), and every remaining page's existing role gates are untouched.
