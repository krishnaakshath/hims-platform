# Document Receiving & Insurance Document Assignment — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — this hardens the Documents module (today a metadata-only report screen) into a real receive-and-file workflow, and extends that same workflow to insurance-related paperwork, which today lives in a separate, rigid, patient-already-known upload control on the Medical Record page.

## 1. What this is, and the boundary it works within

**Correcting the premise, from reading the actual code first:** the Documents screen does not currently do most of what a "receive → tag → file to patient" workflow implies. `src/app/(dashboard)/documents/page.tsx` renders `DocumentsReportTable`, which is a **read-only report** (`ReportTable` + filters) over the `documents` table, with exactly one action available: "Mark Processed" (`MarkProcessedButton` → `PATCH /api/documents/[id]`, which accepts only `{ status: 'new' | 'processed' }`). There is:
- no upload/receive endpoint of any kind — every row in `documents` today comes from `src/db/seed.ts`, not from anything a coordinator can do in the app;
- no way to set or change `documents.patientId` after a row exists — the "file to patient" action the initiative assumed exists **does not exist**; `patientId` is set once (by seed data) and is otherwise immutable through the UI;
- no Download or Delete action anywhere in `DocumentsReportTable` or `MarkProcessedButton`;
- no Unfiled / Not yet processed / Everything filter tabs — only generic column filters (name, status, receivedFrom, label, fileType, patientName) via the shared `DataGridToolbar`;
- and, most consequentially for this spec's design: `documents.fileType` carries an explicit schema comment — `// metadata only, e.g. "PDF" / "JPG" -- no file is ever stored` — meaning the generic Documents table **has never stored an actual file**, unlike `InsuranceCardUpload`, which genuinely uploads bytes to Vercel Blob (`@vercel/blob`'s `put()`) and stores the resulting URL on `patients.primaryCardFrontUrl` / `primaryCardBackUrl`.

So this spec is not "add one missing filing action to an otherwise-working flow." It is: give the Documents module a real receive endpoint (with real file storage, matching the precedent `InsuranceCardUpload` already established), a real file-to-patient action, and the Download/Delete/filter affordances the initiative described — then extend that same, now-real, pattern to insurance documents.

**The one real design decision this spec makes:** insurance-related documents become a `documentType` value inside the existing generic `documents` table — the same receive/tag/assign/file pipeline a coordinator uses for a fax or a scan also handles an insurance card, a secondary-insurance image, a scanned EOB, or an authorization letter. The existing two-slot `InsuranceCardUpload` control on the Medical Record page is **kept, unchanged in place and behavior**, as a separate, deliberately narrower shortcut for the single most common case (a patient or front-desk staff member uploading the *current* patient's *own* primary card while already on that patient's chart, no "who is this for" step needed). The two systems are related by writing to the same underlying storage convention (Vercel Blob) and, once a document is filed to a patient, being visible together — they are not merged into one control, because they solve different problems:

| | Generic Documents (`documents` table) | `InsuranceCardUpload` (`patients.primaryCard*Url`) |
|---|---|---|
| Who is it for, at upload time | Unknown or known — "leave blank if unknown" is the whole point | Always the specific patient whose chart you're already on |
| What can it hold | Any `documentType`, unlimited count per patient | Exactly two fixed slots: primary front, primary back |
| Who uploads it | Staff receiving something from outside (fax, mail, scanner, front-desk intake) | Staff or patient-portal self-service, already on that patient's record |
| Storage | New: Vercel Blob (see §2) | Already Vercel Blob |

**Why not deprecate `InsuranceCardUpload` and route everything through the generic flow:** the Medical Record page is explicitly out of scope for layout changes in this initiative (a separate spec owns that page), and `InsuranceCardUpload`'s whole value is zero extra clicks for the single common case — a patient-portal user uploading their own primary card shouldn't have to pick "what is it" or "which patient" from a dropdown when both answers are already fixed by context. Collapsing that into the generic picker would be a regression for that path, not a hardening of it.

**Explicitly out of scope:**
- Rebuilding inpatient/outpatient tracking. **Confirmed by reading the code, not assumed:** `admissions` (`src/db/schema.ts:555`) already has a `status` enum (`admitted` / `discharged`), and `getActiveAdmissionForPatient()` (`src/lib/queries/admissions.ts:31`) already answers "is this patient currently inpatient." The Patient Detail page already renders this via `InpatientHistoryPanel`, which already shows "Currently admitted" vs. "Discharged" per admission. This spec's only obligation here is narrower than it sounds (§6): let a filed document optionally carry a reference to the admission it was filed under, so a document filed during an inpatient stay is visibly filed "under Admission #N, admitted 2026-09-12" rather than just "under Patient X" — it does not add any new inpatient/outpatient state.
- OCR or automatic document classification. This was never actually built (no such copy exists in the current UI to preserve — the "What is it" step doesn't exist yet either), but the design principle matches this codebase's established pattern elsewhere of keeping a human in the loop for anything that could misfile PHI (see the public-booking-widget spec's "software surfaces a fact, a human decides" precedent). The `documentType` value is always staff-entered at receive time or at filing time — never inferred from the file's name, extension, or contents.
- Tebra/IntakeQ integration, patient demographic fields, and the Medical Record page's layout — owned by parallel specs.
- Fax transmission realism (`faxes`/Fax History stays exactly as-is — a separate, already-disclosed simulation, per the schema comment at `src/db/schema.ts:709`). This spec does not connect incoming faxes to `documents` rows automatically; a fax arriving is still logged in the Fax History tab, and a staff member receiving its contents still creates a `documents` row through the flow in §3, exactly as they would for a mailed or hand-delivered item today.
- Retroactively backfilling real files for existing seeded/legacy `documents` rows that only ever had metadata. Existing rows keep `fileUrl: null` and are treated as "on paper, filed for reference" — filing (assigning `patientId`) and downloading are two independent capabilities; a document can be filed without a stored file.

## 2. Data model changes (additive only)

```ts
// New enum values on the existing documentLabelEnum, renamed in place to documentType
// (see migration note below -- this is the one non-additive rename this spec makes,
// and it's necessary: "label" undersells what this field now drives).
export const documentTypeEnum = pgEnum('document_type', [
  'other',
  'drivers_license',
  'legal_document',
  'insurance_card_primary_front',
  'insurance_card_primary_back',
  'insurance_card_secondary_front',
  'insurance_card_secondary_back',
  'insurance_eob',
  'insurance_authorization',
])

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  documentDate: date('document_date').notNull(),
  status: documentStatusEnum('status').default('new').notNull(),
  receivedFrom: text('received_from').notNull(),
  documentType: documentTypeEnum('document_type').default('other').notNull(), // renamed from `label`
  patientId: text('patient_id').references(() => patients.id),
  admissionId: integer('admission_id').references(() => admissions.id), // new, nullable -- see §6
  fileUrl: text('file_url'), // new, nullable -- Vercel Blob URL; null for pre-existing metadata-only rows
  fileType: text('file_type').notNull(), // unchanged: display metadata, e.g. "PDF" / "JPG"
  filedByName: text('filed_by_name'), // new, nullable -- who last set/changed patientId, for the audit trail on the row itself
  filedAt: timestamp('filed_at'), // new, nullable -- when patientId was last set
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

**Why rename `label` to `documentType` rather than adding a parallel column:** the column already means "what is this document" — `LABEL_TEXT` in `DocumentsReportTable.tsx` already renders it as the classification a coordinator picks. Adding the insurance-specific values to it directly (rather than inventing a second `insuranceSubtype` column alongside a preserved `label`) avoids a document having two overlapping "what is it" fields that could disagree. This is a real migration (rename column + expand enum + backfill), not a pure additive change — called out explicitly here rather than glossed over as "additive only" like the rest of this section.

**Why `patientId` stays nullable and a plain FK, not a required field at creation:** this is the entire point of "receive first, file later" — a fax that arrives with no cover sheet naming a patient is still a real, receivable event. Forcing a patient at creation time would just reintroduce the current system's actual failure mode under a friendlier UI.

**Why `admissionId` is nullable and independent of `patientId`:** most filed documents (a driver's license copy, a signed consent form, an outpatient's insurance card) have no associated admission at all — `admissionId` is only ever set when staff explicitly indicate this document belongs to a specific inpatient stay (e.g., paperwork that arrived while the patient was admitted and is discharge-relevant). It references `admissions.id` directly, not derived automatically from "whatever admission is currently active," because a document filed today could concern a stay from last month.

## 3. The receive → tag → file workflow (generic Documents)

**`POST /api/documents`** — new route, staff-only (`admin`, `crc`, `frontdesk` — matches `InsuranceCardUpload`'s existing write tier; `pi` does not get intake/filing work, matching that role's established "clinical evidence review, not operations" boundary in `role-capabilities.ts`). Accepts `multipart/form-data`:
- `file` (required, any of the types this practice actually receives — PDF, JPEG, PNG, WebP; same `ALLOWED_TYPES`-style allowlist pattern as `insurance-card/route.ts`, widened to include `application/pdf` since faxes and EOBs are routinely PDFs)
- `name` (required, defaults to the uploaded filename if not overridden)
- `documentDate` (required)
- `receivedFrom` (required, free text — unchanged from today)
- `documentType` (required, one of `documentTypeEnum` — this is the "What is it" dropdown; defaults to `other`, never inferred from the file)
- `patientId` (optional — "Patient (leave blank if unknown)"; when omitted, the document is created **Unfiled**)
- `admissionId` (optional, only meaningful when `patientId` is set — see §6)

On success: uploads the file to Vercel Blob (`put(\`documents/${crypto.randomUUID()}-${file.name}\`, file, { access: 'public' })`, mirroring `insurance-card/route.ts`'s path-naming convention), inserts the `documents` row with `fileUrl` set, `status: 'new'`, and `patientId`/`filedByName`/`filedAt` set together if a patient was chosen at receive time. Invalidates `documentsListCacheKey()` (and `patientDetailCacheKey(patientId)` when a patient was set, matching `insurance-card/route.ts`'s precedent of invalidating the patient-detail cache on any write that could affect what that page renders). Calls `logAudit(session, `received document "${name}" (${documentType})`, patientId ?? null)`.

**`PATCH /api/documents/[id]`** — extended, not replaced. Today it accepts only `{ status }`. This spec widens its schema (still `.strict()`) to:

```ts
const updateDocumentSchema = z.object({
  status: z.enum(['new', 'processed']).optional(),
  patientId: z.string().nullable().optional(), // the actual missing "file to patient" action
  admissionId: z.number().nullable().optional(),
  documentType: documentTypeEnum.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'At least one field required')
```

Setting `patientId` (filing or re-filing an Unfiled document) also sets `filedByName: session.name` and `filedAt: now()` server-side — never client-supplied, matching this codebase's existing "server sets who/when, client never does" convention (see `admissions.dischargedAt`, `bookingRequests.reviewedAt`). Explicitly setting `patientId: null` un-files a document back to Unfiled (a real, supported action — a coordinator who filed something to the wrong patient needs a way back, not just forward). Every PATCH still calls `logAudit`, now describing whichever fields actually changed (e.g. `filed document 42 to patient RD-0001`, matching the existing `marked document ${id} as ${status}` phrasing style already in the route).

**`DELETE /api/documents/[id]`** — new, `admin`-only (deleting a received document — as opposed to marking it processed or refiling it — is a destructive action on what may be the only record a document was ever received; matching this codebase's convention of reserving hard deletes for admin, e.g. `DeletePatientButton`'s existing admin-only gating). Deletes the Blob object (best-effort — a failed Blob delete does not block the DB delete, matching the general principle that the audit/database record of "this existed and was removed" outlives storage cleanup) and the `documents` row. Logs `deleted document ${id} ("${name}")`.

**`GET /api/documents/[id]/download`** — new, same staff tier as receive, a thin redirect to `fileUrl` (302) after confirming the requester has an authenticated session — the file itself is already public-URL Blob storage (matching `InsuranceCardUpload`'s existing security posture, where `primaryCardFrontUrl` is rendered as a plain `<img src>` with no additional gating), so this route's only real job is producing an audit-logged access event (`logAudit(session, `downloaded document ${id}`, patientId)`) before redirecting, and returning 404 for a row with no `fileUrl` (a metadata-only legacy row has nothing to download).

**UI changes to `DocumentsReportTable` / the Documents page:**
- A new **Receive Document** form/modal (staff-only, hidden entirely for a role without write access — matching `InsuranceCardUpload`'s "no render, not disabled" pattern) with the fields above.
- Filter tabs — **Unfiled** (`patientId IS NULL`), **Not yet processed** (`status = 'new'`), **Everything** (no filter) — added above the existing column-filter toolbar, defaulting to Unfiled on load (the operationally important view: "what still needs a human decision").
- A **Patient** column control on each Unfiled row: an inline assign-to-patient dropdown (patient search, same pattern as other patient-pickers in this app) that calls the widened `PATCH` — this is the actual "file to patient" action that did not exist before.
- **Download** and **Delete** actions added to the Actions column alongside the existing Mark Processed button, gated per §7.

## 4. Insurance documents through the same pipeline

An insurance-related item — a secondary insurance card photo, a scanned EOB, an authorization letter, or even a *replacement* primary card image received by fax rather than through the portal — is received through the exact `POST /api/documents` flow in §3, with `documentType` set to one of the `insurance_*` values. No new endpoint, no new table, no new UI pattern: this is the design decision from §1 made concrete. A coordinator scanning a stack of mail uses one screen and one mental model regardless of whether the third item in the stack turns out to be a consent form or an EOB.

**Where a filed insurance document becomes visible on the patient's record:** the Medical Record page's Insurance section is out of scope for layout changes (§1), so this spec does not add new UI there. Instead, `listDocuments()` (and a new `listDocumentsForPatient(patientId)` helper, following the existing `listAdmissionsForPatient`-style per-patient query naming convention already used for admissions) already returns any document with `documentType` in the `insurance_*` set when filed to that patient — the Documents page's own existing patient filter (`filters.patientName`) already surfaces them today with zero additional work. A parallel spec covering the Medical Record page's layout can choose to surface these inline later; this spec does not presume that decision.

**Why the two fixed `insurance_card_primary_*` values still exist as `documentType` options even though `InsuranceCardUpload` already handles that exact case:** because the generic Documents flow is also the *fallback* path for the primary card — e.g., a primary card image that arrives by fax rather than through `InsuranceCardUpload`'s direct patient-chart upload. Both paths can produce a primary-card image; they are not mutually exclusive, and this spec does not attempt to keep them in sync (uploading a new primary card through `InsuranceCardUpload` does not touch any `documents` row, and vice versa — they are two independent records of two independently true facts, matching how `bookingRequests` and `appointments` are kept as two honestly-different tables in the public-booking-widget spec rather than forced to reconcile).

## 5. Secondary and beyond: what `InsuranceCardUpload` still can't do, deliberately

`InsuranceCardUpload` and `patients.secondaryCard*Url` are **not** added in this spec — `patients` schema comments already note secondary intentionally has no card columns, and this spec doesn't reopen that boundary. Instead, a secondary card, or any insurance document beyond primary front/back, is received and filed as a generic `documents` row with the matching `documentType` (`insurance_card_secondary_front`, `insurance_eob`, `insurance_authorization`, etc.). This is the direct answer to the initiative's "not just primary front/back" requirement: rather than growing `patients` with more and more fixed insurance-image columns (a pattern that doesn't scale — the next request is always "and what about the ID card for a tertiary payer" or "the referral authorization" or "the workers' comp claim letter"), unbounded insurance paperwork lives in the unbounded, already-general `documents` table, tagged by `documentType`, filterable by patient. Only the single highest-frequency case (primary card, self-service, already-known-patient) keeps its dedicated fast-path control.

## 6. Inpatient/outpatient visibility (confirmed scope, not new tracking)

Per §1, `admissions.status` and `getActiveAdmissionForPatient()` already exist and already work; the Patient Detail page's `InpatientHistoryPanel` already renders "Currently admitted" vs. "Discharged." This spec's actual, narrow obligation:

1. The **Receive Document** form (§3), when a `patientId` is chosen, shows that patient's current status inline (read-only text, e.g. "Currently admitted — Room 214B" or "Outpatient," sourced from `getActiveAdmissionForPatient(patientId)`) purely as context for the person filing the document — it does not gate or change anything based on this status.
2. When the chosen patient has an active admission, the form additionally offers the optional "Associate with this admission" checkbox, which sets `admissionId` on the new `documents` row (§2) to that active admission's id. This is the one new, real piece of data this spec adds toward "add all the data regarding the patient, whether they are inpatient or outpatient": a document can now say not just *whose* it is but, when relevant, *which stay* it belongs to.
3. `listDocumentsForPatient()` includes `admissionId` in its return shape so a future Medical Record or Inpatient History view (out of scope here, per §1) could show "filed under Admission #14" next to a document — this spec makes that data available without itself rendering it anywhere new.

This spec does **not** add an inpatient/outpatient flag to `documents` directly, and does not duplicate `admissions.status` anywhere — a document's inpatient/outpatient context is always derived by joining through `admissionId` (when set) or through the patient's current admission state (when not), never stored as a redundant boolean that could drift out of sync with the real admission record.

## 7. Role gating summary

| Action | Allowed |
|---|---|
| View Documents list (any filter tab) | admin, pi, crc, frontdesk (matches existing `listDocuments()` read access — unchanged) |
| Receive a document (`POST /api/documents`) | admin, crc, frontdesk (matches `InsuranceCardUpload`'s existing write tier; not pi) |
| File / re-file / un-file a document to a patient (`PATCH ... patientId`) | admin, crc, frontdesk |
| Change document type or mark processed (`PATCH ...`) | admin, crc, frontdesk |
| Download a document | admin, pi, crc, frontdesk (read access — matches list-view access; downloading is not a write) |
| Delete a document | admin only (destructive, matches `DeletePatientButton`'s admin-only precedent) |
| Upload primary insurance card via `InsuranceCardUpload` | admin, crc, frontdesk (unchanged from today) |
| Associate a document with a specific admission | admin, crc, frontdesk (same tier as receiving/filing — not a separate permission) |

## 8. Testing

Following `tests/api/documents.test.ts`'s existing real-DB, `vi.mock('@/lib/auth', ...)`, shared-seeded-row-with-`afterAll`-cleanup convention, and `tests/api/patients-insurance-card.test.ts`'s `@vitest-environment node` + `vi.mock('@vercel/blob', ...)` pattern for file-upload routes:

- `tests/api/documents.test.ts` (extended): existing PATCH tests kept; new cases — PATCH with `patientId` sets `filedByName`/`filedAt` and is reflected in `getDocument`; PATCH with `patientId: null` un-files a previously-filed document; PATCH rejects an empty body (no fields) per the `.refine`; PATCH still rejects unknown fields (mass-assignment guard, unchanged).
- `tests/api/documents-receive.test.ts` (new): `POST` with no `patientId` creates an Unfiled row with `status: 'new'`; `POST` with a `patientId` sets `filedByName`/`filedAt` immediately; rejects a disallowed file type; rejects a non-staff role (403); rejects a `documentType` not in the enum; a role below the write tier (pi) gets 403.
- `tests/api/documents-delete.test.ts` (new): admin can delete; crc/frontdesk get 403; deleting a row with `fileUrl` calls the mocked Blob delete; deleting a metadata-only legacy row (`fileUrl: null`) succeeds without attempting a Blob delete; 404 for a non-existent id.
- `tests/api/documents-download.test.ts` (new): authenticated staff role gets a 302 to `fileUrl`; a row with `fileUrl: null` returns 404; unauthenticated request is rejected; download is audit-logged.
- `tests/lib/queries/documents.test.ts` (extended): `listDocumentsForPatient(patientId)` returns only that patient's filed documents, including `admissionId` in the row shape; `listDocuments()` continues to return the full joined set unchanged.
- `tests/api/patients-insurance-card.test.ts`: unchanged — this spec does not modify that route's behavior, and its existing three cases (upload succeeds, rejects non-image, rejects non-write role) remain the regression check that the dedicated shortcut still works exactly as before.

## 9. Migration notes

Renaming `documents.label` to `documents.documentType` and expanding `documentLabelEnum` into `documentTypeEnum` requires a real Drizzle migration (column rename preserves existing seeded values under their original names — `other`/`drivers_license`/`legal_document` are a strict subset of the new enum, so no data rewrite is needed, only an enum-type change and column rename). `fileUrl`, `admissionId`, `filedByName`, and `filedAt` are added as nullable columns with no backfill — every pre-existing seeded row simply has `fileUrl: null` (a metadata-only historical record, as it always was) and `filedByName`/`filedAt: null` (its original `patientId`, where seeded, predates this spec's filing-audit trail and is left as an honest gap rather than a fabricated retroactive "filed by" attribution).

---

## Self-review

- **Placeholder scan:** no `TODO`/`TBD`/bracketed-placeholder text remains; every field, enum value, and route in §2–§7 is concretely specified.
- **Internal consistency:** `documentType` is used consistently after its introduction in §2 (no lingering reference to the old `label` name outside the migration note in §9, where the old name is intentionally named for the migration's own sake). Role gating in §7 matches every access-tier claim made in §3–§6 (no route describes a tier in prose that contradicts the table).
- **Scope check:** every item in the "explicitly out of scope" list in §1 is honored elsewhere in the spec — no section quietly reintroduces OCR/auto-classification, no section edits Medical Record page layout, no section adds new admissions/inpatient state beyond the `admissionId` reference described in §6.
- **Ambiguity check:** the one deliberately flagged open question for the next reviewer is in §9 — whether pre-existing seeded `documents` rows with a `patientId` but no filing audit trail should get a synthetic backfilled `filedByName`/`filedAt` (this spec says no, leave them null, but a reviewer closer to this pilot's demo/reporting needs may want a cosmetic backfill instead). A second, smaller open question: §3 widens the file-type allowlist to include `application/pdf` for the generic Documents route (unlike `InsuranceCardUpload`, which is image-only by design) — worth confirming this is the intended divergence rather than an oversight, since a PDF insurance card scan would otherwise be rejected by the same allowlist reasoning that governs the image-only shortcut.
