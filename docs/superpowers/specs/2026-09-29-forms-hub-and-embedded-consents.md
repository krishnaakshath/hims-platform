# Forms Hub and Embedded Consents — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** the first spec in this backlog driven by screenshots of a real reference EHR ("Meridian") rather than by a missing capability. Everything here already half-exists: this app has form templates, a `category` column, an intake portal, and a complete e-signature mechanism (see `docs/superpowers/specs/2026-09-28-e-signatures.md`). This spec reorganizes and re-sequences those parts; it adds one genuinely new domain object (a reusable consent document) and no new signing mechanism at all.

## 1. What this is, and the boundary it works within

Two related changes, one to staff-facing organization and one to patient-facing sequencing.

**Part A — the Forms Hub.** `/forms` currently derives its groupings from `formTemplates.category` (`[...new Set(templates.map(t => t.category))]`). The reference organizes templates into named folders that staff create and file templates into, and most of those folders are empty. That is the whole design problem: **a grouping derived from a text column on the children cannot represent a folder with no children in it.** A folder named "Research Forms" with 0 forms has no row anywhere to carry its name. This is the reason Part A needs a real table rather than a rename of `category`.

**Part B — consents inside the form, not after it.** Today a consent is a post-hoc action: a patient fills out a `Consent Forms`-category template through `/intake/[token]`, the submission lands in `partial`, and only then — back in the patient portal forms list — does a `SignConsentFormAction` appear for them to sign (`src/app/patient-portal/(authenticated)/forms/page.tsx` lines 65–67). That flow requires the patient to leave the form, log into the portal, find the row, and sign. Real intake packets don't work that way: the consent text is a page of the packet, and the signature is the last thing you do before submitting. This spec moves the signing step into `/intake/[token]` itself.

**The one real design decision this spec makes, and why:** Part B changes *where and when* a consent is signed, and nothing else. The signature record, the typed-name-plus-attestation mechanism, and the convention of storing the exact wording verbatim at signing time (`signatures.attestationText`) are untouched — they are already correct, already tested, and already the reason a wording edit can never retroactively change what someone agreed to. Everything new here is a pointer to *which* consent was signed, never a change to *how*.

This spec adds:
1. A **`formTemplateFolders`** table and a nullable **`formTemplates.folderId`** — one flat level of named folders, which can be empty.
2. A **`consentDocuments`** table — a reusable, named block of consent wording that exists independently of any one template.
3. A **`formTemplateConsents`** join table — which consent documents are attached to which template.
4. A **`formSubmissionConsents`** table — the per-submission instance of an attached consent, which is the thing a patient actually signs.
5. A new `signatures.signableType` value, **`'form_submission_consent'`**, pointing at `formSubmissionConsents.id`. No new column on `signatures`.
6. A redesigned `/forms` hub, a redesigned template editor toolbar with a **Consent Forms** tab and a right-hand info panel, an `/forms/archived` view, and a `/consent-documents` library page.
7. An inline consent step in `/intake/[token]`, and a completion gate: a submission with unsigned attached consents cannot be marked `completed`.

**Explicitly out of scope:**

- **"Upload Existing Form."** The reference shows this button next to "Create New". Turning an uploaded PDF or Word document into a `formTemplates.questions` array needs a real document parser or vendor — the same "needs a real business step" boundary this codebase already draws for e-prescribing and clearinghouse connectivity. This spec deliberately does **not** add the button. A button that opens a file picker and then can't do anything is worse than its absence.
- **Nested folders.** One flat level. `formTemplates.folderId` points at a folder; a folder has no parent. The reference shows no nesting either.
- **A rich-text consent editor.** `consentDocuments.bodyText` is plain text, matching what the reference shows and what the e-signatures spec already settled: the wording that matters is the wording that gets stored verbatim in the attestation, and plain text makes "the exact string the patient saw" unambiguous in a way that serialized rich text does not.
- **Consent document versioning.** No `consentDocumentVersions` table. Editing wording is allowed at any time and never touches past signatures, because each past signature already carries its own verbatim copy of the wording it attested to. A version table would be a second source of truth for something `signatures.attestationText` already records correctly.
- **Any change to the e-signature mechanism itself** — the typed-name input, the attestation checkbox, `SignatureCapture`, or what `signatures` stores. See §10 for one honest discrepancy between the reference screenshot and what this table actually captures.
- **Patient demographic fields, Tebra, or IntakeQ.** Nothing in this spec reads or writes a demographic field, and nothing here depends on the separate foundational migration being specced in parallel.

## 2. Data model changes (additive only)

```ts
export const formTemplateFolders = pgTable('form_template_folders', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Added to the existing formTemplates table
folderId: integer('folder_id').references(() => formTemplateFolders.id), // nullable -- an un-foldered template is a first-class case, shown as its own card

export const legalReviewStatusEnum = pgEnum('legal_review_status', ['draft', 'reviewed'])

export const consentDocuments = pgTable('consent_documents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  bodyText: text('body_text').notNull(),
  legalReviewStatus: legalReviewStatusEnum('legal_review_status').default('draft').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// Which consent documents are attached to which template. UNIQUE on
// (formTemplateId, consentDocumentId) -- attaching the same document twice
// is a mistake, not a supported configuration.
export const formTemplateConsents = pgTable('form_template_consents', {
  id: serial('id').primaryKey(),
  formTemplateId: integer('form_template_id').notNull().references(() => formTemplates.id),
  consentDocumentId: integer('consent_document_id').notNull().references(() => consentDocuments.id),
  sortOrder: integer('sort_order').default(0).notNull(),
})

// The per-submission instance of an attached consent -- created when a form
// is sent, one row per consent document attached to the template at that
// moment. This is the row a signature points at.
export const formSubmissionConsents = pgTable('form_submission_consents', {
  id: serial('id').primaryKey(),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id),
  consentDocumentId: integer('consent_document_id').notNull().references(() => consentDocuments.id),
  sortOrder: integer('sort_order').default(0).notNull(),
})

// Extended, not replaced
export const signableTypeEnum = pgEnum('signable_type', ['form_submission', 'admission_discharge', 'form_submission_consent'])
```

Migration via the existing `npm run db:generate` / `npm run db:push` convention — all of the above is additive (one new nullable column, four new tables, one new enum value), so no existing row needs a backfill and no existing query changes meaning.

**Why `folderId` is a new column and `category` stays exactly as it is.** `category` is not decoration: `formSubmissions.category = 'Consent Forms'` is the live gate in the sign route (`src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts` line 32) and in the patient portal's decision to render `SignConsentFormAction` at all. Repurposing `category` as a folder name would silently break consent signing for every existing submission the moment a staff member renamed a folder. So `category` keeps its current job — a semantic tag on the template — and `folderId` takes the new one: where the template sits in the library UI. The two are genuinely different concepts and the reference shows both (folders in the grid, and a per-template Consent Forms tab that has nothing to do with which folder the template is in).

**Why `formTemplateConsents` is a join table and not a `consentDocumentIds` jsonb array on `formTemplates`.** The reference's consent-document library shows an **"On Forms"** count per document — a consent document belongs to many templates, and a template holds many consent documents. That is a genuine many-to-many, and it is read from *both* directions: the editor's Consent Forms tab reads template → documents, and the library page reads document → templates. A jsonb array on `formTemplates` answers the first cheaply and makes the second a full-table jsonb scan, for no gain.

**Why `formSubmissionConsents` exists rather than hanging the signature off `(formSubmissionId, consentDocumentId)` directly.** `signatures.signableId` is a single integer with no FK. A signature that identifies a *pair* has nowhere to put the second half of the pair. The two ways out were to add a nullable `consentDocumentId` column to `signatures`, or to give the pair its own row with its own id. The e-signatures spec §2 explicitly argued against the first — it chose a polymorphic key precisely to avoid "a table that grows a new nullable column every time a third signable thing is added later" — so this spec follows that precedent rather than being the first exception to it. `formSubmissionConsents.id` is a single integer, which is exactly what `signableId` wants.

`formSubmissionConsents` deliberately does **not** store a copy of the wording. The wording that was actually agreed to is already stored verbatim in `signatures.attestationText`; a second copy here would be a second source of truth that can silently disagree with the first.

**One honest note on snapshotting.** `formSubmissionConsents` rows are written when the form is sent, so detaching a consent document from a template later does not change a packet already in a patient's hands. This is a deliberate divergence from how questions behave — `getIntakePortalData` reads `formTemplates.questions` live, so editing a template does change an in-flight form. The divergence is intentional and narrow: a question changing under a patient produces a confusing form, while a consent changing under a patient produces a signature against something they were never shown. Questions are not being changed to match; that would be a much larger behavior change with its own review surface.

**Archived templates need no new column.** `formTemplates.isActive` already exists and already defaults to `true`, and `PUT /api/form-templates/[id]` already accepts `isActive`. The reference's "5 archived" indicator is `count(isActive = false)`. This was checked before assuming a column was needed.

## 3. The Forms Hub (`/forms`)

Replaces the current flat `category`-derived layout in `src/app/(dashboard)/forms/page.tsx`.

- A **"Questionnaires"** heading over a single grid.
- **Folder cards** — one per `formTemplateFolders` row, showing the folder name and "N forms" — counting `isActive` templates only, so the number always matches what opening the folder shows, and 0 is a normal displayed value rather than a hidden state. Clicking one opens `/forms/folders/[folderId]`, the same grid filtered to that folder.
- **Un-foldered template cards** — templates with `folderId = null`, in the same grid, each showing name, diagnosis tag, and question count (the existing `FormTemplateCard`, unchanged except that the "Inactive" badge case no longer occurs here, see below).
- **"Create New"** — the existing `CreateFormButton`. `formTemplates.category` is `notNull` and the button currently sources it from whichever category heading it sat under — headings that no longer exist. It sends the literal `'Uncategorized'` instead, which staff can change in the editor's Category field, and additionally sends `folderId`: the folder's id when the hub is scoped to a folder, `null` at the top level. A separate **"New folder"** action creates a `formTemplateFolders` row from a name prompt.
- **"N archived"** — a link to `/forms/archived`, listing every template with `isActive = false` regardless of folder (the count is practice-wide, not per-folder, and shows on the top-level hub only) with a Restore action on each. This is a real behavior change worth calling out: today archived templates appear inline in the main grid with an "Inactive" badge, so the redesign removes them from the default view. They become reachable in one click instead of zero, which is the point of archiving them.

`listFormTemplates()` is cached for 30 seconds under `formTemplatesListCacheKey()`. Creating, renaming, or deleting a folder, and filing a template into one, all call the existing `invalidateFormTemplatesList()` — the hub reads folder membership through that same list, so skipping the invalidation would leave a newly-filed template in its old spot for up to 30 seconds.

**Deleting a folder** sets `folderId = null` on its templates and then deletes the folder row. It never deletes a template. The alternative — refusing to delete a non-empty folder — forces staff through a manual un-file loop to reach the same end state, and there is no data at risk either way.

## 4. The template editor (`/forms/[templateId]`)

`FormBuilderEditor` keeps its question list, and its Name / Category / Diagnosis tag fields, exactly as they are — Category is still an editable semantic tag on the template (see §2), it is simply no longer what the hub groups by. What changes is the frame around all of it: a top toolbar and a right-hand info panel, plus a Folder picker beside Category.

**Toolbar**, matching the reference's ordering:
- **Send to Client** — opens the existing `SendFormModal`, pre-filled with this template. No new send mechanism.
- **Preview** — a modal rendering this template's questions read-only, reusing the intake portal's own field rendering so the preview cannot drift from what a patient sees. It creates no `formSubmissions` row and issues no token.
- **Consent Forms** — a tab switching the editor body from the question list to the attached-consents view (§5).
- **Saved-status indicator** — "Saved · 2:14 PM" when the in-memory state matches the last successful save, "Unsaved changes" otherwise, with the existing explicit Save action beside it. This spec deliberately does **not** introduce autosave. The reference shows a saved *status*, which is what is being copied; inferring autosave from it would be a real behavior change (a half-edited question silently reaching a patient mid-edit) smuggled in under a visual redesign.
- **Add New Question** — the existing button, moved from the bottom of the page into the toolbar.

**Right-hand info panel:** the template name, the question count, the attached-consent count, and a static **"Common things you can do here"** list (add a question, mark a question as containing PHI, attach a consent document, send the form to a client, archive the template). It is a static quick-reference, not a checklist with state.

**Consent Forms tab.** Lists the `formTemplateConsents` rows for this template: document name, a truncated first line of its wording, its `legalReviewStatus`, and a per-template **signed count** — `count(signatures WHERE signableType = 'form_submission_consent' AND signableId IN (formSubmissionConsents for submissions of this template))`, derived at read time, never stored. Plus **Attach** (a picker over `consentDocuments`) and **Detach**.

**Detaching a consent document that already has signatures** is allowed and removes only the `formTemplateConsents` row. It does not touch `formSubmissionConsents` and it does not touch `signatures` — packets already sent keep their consent pages, and past signatures stay exactly where they are. The tab shows the signed count next to the Detach action so the person clicking it can see what they are detaching from.

## 5. Consent documents library (`/consent-documents`)

A flat table page, matching the reference's columns:

| Name | Wording (truncated) | On Forms | Signed | |
|---|---|---|---|---|
| Telehealth Consent | [DRAFT — NOT YET REVIEWED…] By signing… | 3 | 12 | Edit |

- **On Forms** — `count(formTemplateConsents WHERE consentDocumentId = …)`.
- **Signed** — `count(signatures WHERE signableType = 'form_submission_consent' AND signableId IN (formSubmissionConsents WHERE consentDocumentId = …))`.
- **Edit** — name and `bodyText` in a plain `<textarea>`, plus the `legalReviewStatus` control. When a document already has signatures, the edit screen shows "N signatures recorded against earlier wording — editing this text does not change what those people agreed to", because that is true and a person editing legal wording should be told it.

**The draft convention.** `legalReviewStatus` is a real enum column, not a marker typed into the wording. A column is queryable — an admin can list every unreviewed consent document before go-live, which is the actual operational need. But the marker must also be *visible to the signer*, so when `legalReviewStatus = 'draft'` the text rendered to the patient is a fixed banner followed by the body:

```
[DRAFT — NOT YET REVIEWED BY LEGAL COUNSEL. DO NOT RELY ON THIS WORDING.]

<bodyText>
```

That composed string — banner included — is exactly what goes into `signatures.attestationText`. So a signature collected against a draft carries permanent, self-evident proof that the signer was shown the draft warning. The banner is derived from the status at render time and never stored on `consentDocuments`, so the two can't drift.

## 6. Inline consent signing in the patient's form flow

`/intake/[token]` becomes: questions, then one consent page per attached consent document, then submit.

- `getIntakePortalData(token)` gains a `consents` array: `{ formSubmissionConsentId, name, renderedText, signedAt | null }[]`, ordered by `sortOrder`, read from `formSubmissionConsents` joined to `consentDocuments`. `renderedText` is the composed banner-plus-body string from §5 — composed server-side, so the client cannot render wording that differs from what will be stored.
- `IntakePortalForm` renders each unsigned consent as a page showing `renderedText` followed by the existing `SignatureCapture` component, unchanged. Already-signed consents render read-only with "Signed by <name> on <date>".
- **New route:** `POST /api/intake/[token]/consents/[formSubmissionConsentId]/sign`, body `{ typedName: string }`, `.strict()`. Authorization is possession of the token, checked through the existing `getSubmissionPatientIdByToken` — the same deliberate no-staff-session, no-portal-session posture already documented at the top of `src/app/api/intake/[token]/route.ts`. It verifies the `formSubmissionConsents` row belongs to the submission that token resolves to (a valid token for form A must not sign a consent belonging to form B), rejects a second signature on an already-signed row with 409, and inserts one `signatures` row with `signableType: 'form_submission_consent'`, `signerRole: 'patient'`, and `attestationText` set to the server-composed `renderedText`. It calls `logPatientPortalAction('signed consent document via intake form', patientId)`.
- **Completion gate:** `PUT /api/intake/[token]` with `complete: true` returns 400 (`'This form has unsigned consent documents'`) when any `formSubmissionConsents` row for the submission lacks a signature. Saving partial progress (`complete: false`) is unaffected — a patient can answer half the questions and come back before signing anything.
- **Creating the rows:** `POST /api/form-submissions` copies the template's current `formTemplateConsents` rows into `formSubmissionConsents` for the new submission, preserving `sortOrder`. A template with no attached consents produces no rows and the intake flow is byte-for-byte what it is today.
- A template with **zero questions and one or more consents** is a valid, supported packet — a consent-only send. The completion gate is the only thing standing between the patient and submit, which is the correct behavior for that case.

The signature insert and the completion update stay two sequential writes, matching the non-transactional posture the sign route already documents. (Correction, final review: that route's comment predates the switch to node-postgres in `src/db/client.ts`, which does support real transactions via `getDb().transaction(...)`; sequential writes here are a choice, not a driver limitation. The send-time insert of the submission and its consent rows in `POST /api/form-submissions` is wrapped in a transaction.) Here the ordering risk is milder than in the existing route: consents are signed one at a time, each in its own request, and completion is a separate later request that re-checks the gate.

## 7. What happens to the existing post-hoc signing path

`POST /api/patients/[anonId]/form-submissions/[id]/sign` and the `SignConsentFormAction` in the patient portal forms list stay in place and keep working for `category = 'Consent Forms'` submissions that have no attached consent documents — including every submission already in flight when this ships.

Exactly one precedence rule decides between the two paths, and it is enforced server-side:

> **If a submission has one or more `formSubmissionConsents` rows, the inline path governs.** The legacy route returns 409 (`'This form's consents are signed within the form itself'`) rather than completing the submission behind the inline gate's back, and the portal forms list renders a "Continue" link to the intake form instead of `SignConsentFormAction`.

Without this rule a `Consent Forms`-category template with attached consent documents would offer two ways to complete the same submission, one of which skips the consents entirely. The client-side half of the rule is UX; the 409 is the boundary.

## 8. API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/form-template-folders` | GET, POST | List, create |
| `/api/form-template-folders/[id]` | PUT, DELETE | Rename, delete (un-files its templates) |
| `/api/form-templates/[id]` | PUT | Extended to accept `folderId: number \| null` |
| `/api/form-submissions` | POST | Extended: also copies the template's `formTemplateConsents` into `formSubmissionConsents` |
| `/api/consent-documents` | GET, POST | List (with On Forms / Signed counts), create |
| `/api/consent-documents/[id]` | GET, PUT | Read, edit name / `bodyText` / `legalReviewStatus` |
| `/api/form-templates/[id]/consents` | GET, POST | List attached, attach one |
| `/api/form-templates/[id]/consents/[consentDocumentId]` | DELETE | Detach |
| `/api/intake/[token]/consents/[formSubmissionConsentId]/sign` | POST | Patient signs one consent inline |

Every staff route is `.strict()`-validated, calls `logAudit(session, …, null)` on writes, and invalidates `formTemplatesListCacheKey()` where it affects the hub's data. No DELETE route exists for consent documents: a document with recorded signatures must not vanish, and one without them is harmless to leave in the library. If a soft-delete is wanted later it is a one-column follow-up, not something to decide here.

## 9. Testing

Real DB-backed tests, following the existing conventions in `tests/api/form-templates.test.ts` (mock `@/lib/auth`'s `requireSession`, track created ids, clean up in `afterEach`, scope every audit-log assertion to that test's own action string rather than reading "the latest row" — the dev DB has concurrent writers) and `tests/api/form-submission-sign.test.ts` (scope signature cleanup by `(signableType, signableId)`, never `signableId` alone).

- **`tests/api/form-template-folders.test.ts`** — create a folder; it appears with 0 templates; file a template into it and the count becomes 1; rename; delete a non-empty folder and assert its templates survive with `folderId = null`; a non-admin/crc role is rejected.
- **`tests/api/form-templates.test.ts` (extended)** — `PUT` accepts `folderId`; `PUT` accepts `folderId: null` to un-file; a `folderId` pointing at no folder is rejected rather than stored.
- **`tests/api/consent-documents.test.ts`** — create/read/edit; `legalReviewStatus` defaults to `'draft'`; the On Forms count reflects attachments across two templates; the Signed count reflects signatures across submissions of both; editing `bodyText` after a signature exists leaves that signature's `attestationText` byte-for-byte unchanged (this is the load-bearing assertion of the whole spec).
- **`tests/api/form-template-consents.test.ts`** — attach, detach, attaching the same document twice is rejected; detaching after signatures exist leaves both `formSubmissionConsents` and `signatures` rows intact.
- **`tests/api/intake-consent-sign.test.ts`** — sending a form with attached consents creates the matching `formSubmissionConsents` rows; signing inserts a `signatures` row with `signableType = 'form_submission_consent'` whose `attestationText` contains the draft banner when the document is `'draft'` and does not when it is `'reviewed'`; signing the same row twice returns 409; a valid token for form A cannot sign a consent belonging to form B; `PUT /api/intake/[token]` with `complete: true` is rejected while any consent is unsigned and succeeds once all are signed; a submission with no attached consents completes exactly as it does today.
- **`tests/api/form-submission-sign.test.ts` (extended)** — the legacy route returns 409 for a submission that has `formSubmissionConsents` rows, and still behaves exactly as before for one that doesn't.

## 10. Open questions for the next reviewer

1. **The reference captures more signer metadata than this table does.** The screenshot describes "the signer's name, the time, their address and browser, and a hash of the exact wording as it stood at that moment". This codebase's `signatures` table stores the name, the time, and the **verbatim** wording — which is strictly more informative than a hash — but it does **not** store an IP address or user agent. Adding them is a change to the attestation record, which this spec was scoped out of making. Flagging it rather than doing it quietly: someone should decide whether IP/user-agent capture is wanted, as its own small spec.
2. **`/api/form-templates` write routes are not role-gated today.** `POST /api/form-templates` and `PUT /api/form-templates/[id]` call bare `requireSession()`, so any authenticated role — including `pi` and `frontdesk` — can create or edit a form template through the API. The admin/crc restriction exists only in `LeftNav`'s `roles: ['admin', 'crc']` on the `/forms` entry, which hides the page but enforces nothing. Every route this spec adds is gated explicitly at the route level (§11). Tightening the two pre-existing routes to match is a behavior change to shipped endpoints and belongs in its own change, not buried in a redesign.
3. **Whether the `category = 'Consent Forms'` gate should eventually be retired.** Once attached consent documents are the normal way to collect a consent, the category-based path in §7 is legacy surface kept alive for in-flight submissions. It can be removed once none remain, but this spec does not set that date.

## 11. Role gating summary

| Action | Allowed |
|---|---|
| View the Forms Hub, folders, and archived templates | admin, crc (matches the existing `/forms` nav gate) |
| Create / rename / delete a folder, file a template into one | admin, crc (write tier for form-template administration) |
| View the consent documents library | admin, crc |
| Create / edit a consent document, set its legal-review status | admin, crc |
| Attach / detach a consent document to a template | admin, crc |
| Archive / restore a template | admin, crc |
| Send a form to a client | admin, crc (unchanged — the existing `SendFormModal` path) |
| Sign a consent inline in the intake form | The patient holding the intake token (token-authorized, no session — matches the existing `/api/intake/[token]` posture) |
| Sign a consent via the legacy portal action | The patient themself, via patient-portal session only (unchanged) |
| View per-template / per-document signed counts | admin, crc |
