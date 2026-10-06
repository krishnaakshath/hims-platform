# Imaging Attachments on Lab Orders — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** an extension of the Labs module, sequenced to start only after `2026-09-29-document-insurance-assignment.md` has merged into `hims-platform` — this spec assumes the `documents` table already has `documentType`, `fileUrl`, `filedByName`/`filedAt`, a real `POST /api/documents` with `@vercel/blob` upload, and the `DELETE`/`download` routes that spec introduces. It adds no file-storage machinery of its own; it adds one enum value, one nullable FK, and one order-scoped entry point on top of that pipeline.

## 1. What this is, and the boundary it works within

The user's request, verbatim: *"if the doctor asks the patient to take an X-ray that should be there for the doctor to see, so it gets automatically uploaded from the lab itself."*

**Read against the code, that request decomposes into three parts, and two of them already exist:**

1. *"the doctor asks the patient to take an X-ray"* — **ordering already works.** A `pi` or `admin` session opens `LabResultsSection`'s "Order labs" button on the Medical Record page (`src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx:337`, gated by `canOrderLabs = ['admin','pi']` at line 101), picks a catalog entry in `OrderLabTestModal`, and `POST /api/patients/[anonId]/lab-orders` creates a `labOrders` row. What does *not* exist is an X-ray to pick: `LAB_TESTS_SEED` (`src/db/seed.ts:393-403`) is ten chemistry/hematology entries (CBC-DIFF, CMP, TSH, LIPID, HBA1C, LITH, VPA, UDS, PRL, VITD) and nothing else. The catalog needs imaging entries, and — because the UI must know whether to ask for a number or an image — `labTests` needs a way to say which kind of study a row is. That is this spec's only change to the ordering side.
2. *"gets uploaded from the lab"* — **the lifecycle already works, the file does not.** `markCollected()` and `enterResult()` (`src/lib/queries/lab-orders.ts`) already drive `ordered → collected → resulted` with WHERE-clause guards, and `labResults` already carries a `flag` of `normal | abnormal | critical`. There is no file anywhere in the lab subsystem. This spec adds the file, and only the file.
3. *"there for the doctor to see"* — **both viewing surfaces already exist.** `/labs` (`LabWorklist`) is the cross-patient worklist; `LabResultsSection` on the Medical Record page is the per-patient chart view. This spec adds an attachment affordance to each of them and creates no new page.

**The one real design decision this spec makes:** an imaging file is a `documents` row with `documentType: 'imaging_result'` and a new nullable `labOrderId` FK — not a new `labImages` table, not a new upload endpoint, not a new blob path convention. The document-insurance-assignment spec has already committed this codebase to exactly one receive-and-store-a-file pipeline (Vercel Blob `put()` → a `documents` row carrying `fileUrl`), with download, delete, and audit already built around it. Adding `labOrderId` here mirrors, line for line, how that spec added `admissionId`: a nullable FK that says *which clinical event this document belongs to*, set explicitly by a human action, never inferred.

**Why not a dedicated `labImages` table:** every column such a table would need (`fileUrl`, `fileType`, uploader name, uploaded-at, the blob-cleanup-on-delete behavior, the audit-logged download redirect) already exists on `documents` and is already tested. A second table would duplicate all of it and then immediately diverge — a coordinator looking at the Documents screen would not see imaging, and an imaging file would be the one file in the system that the admin-only delete route could not clean up. The `documents` table is already the answer to "where does a stored file live in Clinsync"; imaging is not special enough to be the exception.

**Why not stretch `labResults` to hold the image:** `labResults` has a `.unique()` constraint on `labOrderId` — exactly one result row per order. An imaging study routinely has more than one file (two views of a chest, a repeat after positioning, a scanned outside report attached to the same order). Putting a `fileUrl` on `labResults` would cap every order at one image and would tangle "the radiologist's read" with "the pixels," which arrive at different times, from different people. Keeping them separate is what lets an order sit honestly in `collected` with two images attached and no read yet.

**Explicitly out of scope:**
- **DICOM viewing, windowing, measurement, or any PACS behavior.** This is document attachment: a JPEG/PNG/WebP/PDF of a study, viewed with the browser's own image rendering, the same way `InsuranceCardUpload`'s card images are viewed today. `.dcm` is not in the accepted-type allowlist (§3) and no DICOM parsing library is added.
- **OCR or automated result extraction from the image.** The impression/read text is always typed by a human, matching the document-insurance-assignment spec's own "never inferred from the file's name, extension, or contents" rule and the public-booking-widget spec's "software surfaces a fact, a human decides" precedent.
- **Integration with an external imaging vendor, modality, worklist (DMWL), or HL7/DICOM feed.** No such integration exists in this codebase and none is added speculatively — the same posture the `faxes` table already takes toward real fax transmission (`src/db/schema.ts:709`). "Automatically uploaded from the lab" is satisfied by *the person who acquired the image uploading it against the order that requested it, in one action, from the screen they already use* — not by a machine push. §3 makes that single action as close to automatic as the app can honestly get; §8 flags the gap explicitly rather than implying a feed exists.
- **A new "lab technician" or "radiology technologist" role.** See §5 — the upload action reuses the role tier that already enters lab results.
- **Patient-portal visibility of imaging files.** Lab results are not surfaced in the patient portal today; this spec does not change that boundary.
- **Changing the `ordered → collected → resulted → cancelled` state machine.** No new statuses, no new transitions, no edits to `markCollected()`/`enterResult()`/`cancelOrder()`'s existing guards.

## 2. Data model changes (additive only)

Three changes, all additive — no column renames, no data rewrite, no backfill script.

### 2a. A category on `labTests`

```ts
export const labTestCategoryEnum = pgEnum('lab_test_category', ['lab', 'imaging'])

export const labTests = pgTable('lab_tests', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  category: labTestCategoryEnum('category').default('lab').notNull(), // new
  defaultUnit: text('default_unit'),
  referenceRange: text('reference_range'),
})
```

**Why a real column and not a name/code string match:** the UI has to decide, at three separate points, whether an order is an imaging study — which action button to offer on the worklist row, whether to label the result field "Result value" or "Impression", and whether to show the unit/reference-range inputs at all. Inferring that from `name.includes('X-Ray')` would be a silent-failure heuristic that breaks the first time someone adds "Ultrasound, abdominal" to the catalog. `category` is one nullable-free enum column with a default, and the existing nine seeded rows become `'lab'` with no migration work.

**Why `'lab' | 'imaging'` and not a longer modality taxonomy (`xray | ct | mri | us`):** nothing in this spec branches on modality — the upload, storage, viewing, and read-entry behavior is identical for an X-ray and an ultrasound. The modality is already legible in `labTests.name` and `labTests.code` (`'X-Ray, chest, 2 view'` / `'XR-CHEST-2V'`), which is where a human reads it. A modality enum would be a field nothing consumes. YAGNI.

**Why `category` lives on `labTests` (the catalog) and not on `labOrders` (the instance):** whether a study produces an image is a property of the study itself, not of one patient's order for it. Putting it on the order would let two orders for the same test disagree.

### 2b. `imaging_result` as a `documentType` value

```ts
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
  'imaging_result', // new -- this spec
])
```

One appended value on the enum the prerequisite spec establishes. Nothing else about `documentType` changes.

**Why a single `imaging_result` value rather than one per modality:** same reasoning as §2a — `documentType` drives filtering and display grouping on the Documents screen, and "imaging" is the useful grouping there. The specific study is named on the `labOrders` → `labTests` join the attachment already carries.

### 2c. `labOrderId` on `documents`

```ts
export const documents = pgTable('documents', {
  // ...all columns as established by 2026-09-29-document-insurance-assignment.md...
  patientId: text('patient_id').references(() => patients.id),
  admissionId: integer('admission_id').references(() => admissions.id),
  labOrderId: integer('lab_order_id').references(() => labOrders.id), // new, nullable -- this spec
  fileUrl: text('file_url'),
  // ...
})
```

**Why nullable, and why a plain FK:** exactly the reasoning the prerequisite spec gives for `admissionId` — the overwhelming majority of documents have no associated lab order at all, so a `.notNull()` column is wrong on its face. It references `labOrders.id` directly rather than being derived from "the patient's most recent imaging order," because a scanned outside report received today can concern a study ordered last month.

**Why `labOrderId` sits alongside `patientId` rather than replacing it:** `patientId` stays the primary filing axis, so an imaging attachment appears in every patient-scoped document view for free, exactly like any other filed document. `labOrderId` is the *additional* precision. The two are kept consistent by construction, not by a constraint: the only route that sets `labOrderId` (§3) derives `patientId` from the order row itself and never accepts it from the client, so they cannot disagree. This mirrors `enterResult()`'s existing habit of returning `patientId` off the order's own `.returning()` rather than trusting a caller-supplied one.

**Why `labOrderId` is deliberately NOT accepted by the generic `POST /api/documents` or `PATCH /api/documents/[id]`:** those routes let staff set `patientId` freely, including to `null`. If they could also set `labOrderId`, a coordinator could file document 42 to patient A while pointing it at an order belonging to patient B, and the invariant above would need a runtime cross-check on every generic write. Restricting `labOrderId` to the order-scoped route in §3 makes the invariant structural instead of enforced. Correcting a mis-attached image is done by deleting the document (admin, via the prerequisite spec's `DELETE /api/documents/[id]`) and re-uploading against the right order — a deliberately blunt path for a rare mistake, rather than a re-link affordance nobody asked for. §8 flags this if a reviewer disagrees.

## 3. The workflow: order → acquire → attach → read

### 3a. Ordering an X-ray

No route or schema change beyond §2a. `listLabTests()` already returns the whole catalog ordered by name; `OrderLabTestModal` already renders it as a flat `<select>`. The modal groups options into two `<optgroup>`s — "Labs" and "Imaging" — keyed off `category`, and `LabTestOption` gains `category` to carry it. Ordering remains `admin`/`pi`, unchanged.

The catalog gains imaging rows in `LAB_TESTS_SEED`, inserted by the existing idempotent-by-`code` `seedLabTests()` with no change to that function:

| name | code | category | defaultUnit | referenceRange |
|---|---|---|---|---|
| X-Ray, chest, 2 view | XR-CHEST-2V | imaging | null | null |
| X-Ray, chest, 1 view | XR-CHEST-1V | imaging | null | null |
| X-Ray, wrist | XR-WRIST | imaging | null | null |
| X-Ray, knee | XR-KNEE | imaging | null | null |
| CT, head, without contrast | CT-HEAD-NC | imaging | null | null |
| Ultrasound, abdominal | US-ABD | imaging | null | null |

`labTests.referenceRange` is `text` (nullable) in the schema, so `null` is legal at the DB level — but `LAB_TESTS_SEED`'s inline literal type (`src/db/seed.ts:393`) currently declares `referenceRange: string`, because every existing row happens to have one. That annotation widens to `referenceRange: string | null`, matching the `defaultUnit: string | null` already beside it. Unlike a chemistry panel, an imaging study has no numeric reference range to state, and inventing one ("Normal") would be a fake value the UI would then render.

### 3b. Attaching the image — `POST /api/lab-orders/[id]/imaging`

A new route in the existing `/api/lab-orders/[id]/{collect,result,cancel}` family, following that family's exact shape (`requireSession()` → role gate → integer-id parse → act → `logAudit` → JSON).

**Role gate: `['admin', 'pi']`** — see §5 for the reasoning.

Accepts `multipart/form-data`:
- `file` (required) — allowlist `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, matching the widened generic-documents allowlist from the prerequisite spec (a radiology report frequently arrives as a PDF). Max 16 MB, double the `InsuranceCardUpload` 8 MB ceiling, because a diagnostic-resolution chest film routinely exceeds a phone snapshot of an insurance card; enforced with the same `MAX_BYTES` constant pattern.
- `name` (optional) — defaults to the uploaded filename, same as the generic receive route.

Those two fields are the whole payload. There is no per-image caption field and no client-supplied `patientId`, `documentType`, `labOrderId`, `status`, or `filedByName` — the route derives all of them (§3b step 4), and any unrecognized form field is rejected 400, carrying this codebase's `.strict()` mass-assignment discipline over to `multipart/form-data`. (A caption would be genuinely useful and has nowhere to live on `documents` today; §8 open question 1.)

Behavior, in order:

1. Load the order. 404 if it does not exist.
2. **Status guard.** `cancelled` → 409 `'Cannot attach an image to a cancelled order'`. All of `ordered`, `collected`, `resulted` are accepted: attaching a further view to an already-read study (an addendum, a comparison film) is a real thing and blocking it would only push staff into the generic Documents screen, losing the order link.
3. Upload to Vercel Blob: `put(\`imaging/${orderId}-${crypto.randomUUID()}-${file.name}\`, file, { access: 'public' })` — the same `put()` call shape and public-access posture as `insurance-card/route.ts` and the generic documents route, under its own path prefix.
4. Insert the `documents` row via the shared `createDocument()` helper the prerequisite spec factors out of `POST /api/documents` (see the note below), with `documentType: 'imaging_result'`, `labOrderId: orderId`, `patientId` taken from the loaded order row, `receivedFrom: session.name`, `documentDate: today`, `status: 'new'`, `fileUrl` from the blob, `fileType` derived from the MIME type ("JPG"/"PNG"/"WEBP"/"PDF"), and `filedByName: session.name` / `filedAt: now()` — set server-side, never client-supplied, per that spec's own convention.
5. **If and only if the order was in `ordered`**, call the existing `markCollected(orderId)`. Acquiring the image *is* the collection event for an imaging study; requiring a separate "Mark collected" click before the upload button appears would be a step with no information in it. `markCollected()`'s existing `WHERE status = 'ordered'` guard makes this safe under concurrency, and its `ok: false` return is deliberately ignored here — a racing transition means someone else already collected the order, which does not invalidate the upload that just succeeded.
6. `invalidateCache(documentsListCacheKey())` — `listDocuments()` is cached for 15s (`src/lib/queries/documents.ts`), so a new attachment would otherwise be invisible on the Documents screen for up to that long. No lab-order cache key is invalidated because `listWorklist()`/`listOrdersForPatient()` are uncached today; `patientDetailCacheKey()` is not invalidated because lab orders are not part of `getPatientDetail()`'s cached payload.
7. `logAudit(session, \`attached imaging to lab order ${orderId}\`, order.patientId)` and return `201` with `{ id, fileUrl }`.

**On the blob-before-DB ordering:** the upload happens before the DB writes, so a DB failure leaves an orphaned blob object. This matches the generic `POST /api/documents` precedent exactly and is the accepted trade in this codebase — an orphaned blob is invisible and cheap; a `documents` row pointing at a file that was never stored is a broken download link in a chart.

**On reuse, concretely:** this route must not re-implement the upload. The prerequisite spec's `POST /api/documents` already contains the put-then-insert sequence; implementing this spec begins by extracting that sequence into `createDocument(input)` in `src/lib/queries/documents.ts` (the file that already owns `listDocuments`/`getDocument`), leaving `POST /api/documents` as a thin caller. Both routes then produce byte-identical rows apart from the fields they set. The order-scoped route exists only because its *authorization tier and its patient-derivation* differ (§5, §2c) — not because its storage differs.

### 3c. Entering the read

Unchanged. `POST /api/lab-orders/[id]/result` and `enterResult()` are not modified. For an imaging order the radiologist's or clinician's impression goes in `labResults.value` (a `text` column, already `notNull`), `unit` and `referenceRange` are omitted (both already `.optional()` in `enterResultSchema`), and `flag` carries `normal`/`abnormal`/`critical` exactly as it does for a chemistry panel — which is precisely the signal the ordering doctor scans for.

The only change is presentational: `EnterLabResultModal` takes a `category` prop; when it is `'imaging'` the "Result value" `<input>` becomes a `<textarea>` labelled **Impression** and the Unit / Reference range inputs are not rendered (they submit as `undefined`, which the existing `.strict()` schema already accepts). The modal also lists the images already attached to the order, so whoever writes the impression can see what they are reading.

An imaging order with images attached but no impression stays in `collected` — an honest representation of "film taken, not yet read." Uploading an image never sets `resulted`.

## 4. Where the doctor sees it

No new page. Both existing surfaces gain the same attachment affordance, fed by one new query helper.

**New query:** `listImagingForOrders(orderIds: number[]): Promise<Map<number, ImagingAttachment[]>>` in `src/lib/queries/documents.ts` — one `WHERE labOrderId IN (...)` select of `{ id, name, fileUrl, fileType, filedAt, filedByName }` per attachment, grouped into a `Map` keyed by `labOrderId` before returning (an empty `orderIds` array short-circuits to an empty `Map` without touching the DB, since `inArray(x, [])` is a SQL footgun). A single batched query keeps `listWorklist()` and `listOrdersForPatient()` free of an N+1, and lives in `documents.ts` rather than `lab-orders.ts` because it reads the `documents` table; `lab-orders.ts` keeps its existing joins untouched. Both `WorklistRow` and `PatientLabOrderRow` gain `attachments: ImagingAttachment[]` (empty array, never null) and `category: 'lab' | 'imaging'`, populated by their calling Server Components (`labs/page.tsx`, `medical-record/page.tsx`) composing the two queries.

**`/labs` — `LabWorklist` / `LabRow`:**
- An **Attach image** button on any non-`cancelled` row whose order `category` is `'imaging'`, rendered under the same `showActions` condition the existing buttons use and gated on the §5 tier (hidden entirely for a role without it, following `InsuranceCardUpload`'s established "no render, not disabled" pattern rather than a greyed-out control). It opens a small upload dialog that posts to §3b and calls `router.refresh()`, mirroring `markCollected`'s existing busy/row-error handling.
- A thumbnail strip on rows that have attachments — each a link to `GET /api/documents/[id]/download` (the prerequisite spec's audit-logged redirect), so every view of a patient image is logged, not just the upload.
- Rows in the `Resulted` and `Cancelled` groups render the strip read-only; `showActions={false}` already suppresses the buttons there.

**Medical Record page — `LabResultsSection`:** the doctor's actual reading surface.
- A resulted imaging order renders its impression text (`result.value`) where a lab value renders today, with the same `FlagPill`, plus the thumbnail strip beneath it. Because `defaultUnit`/`referenceRange` are `null` for imaging catalog rows, the existing `{r.unit ? ...}` and `{r.referenceRange && ...}` conditionals already render nothing — no change needed to that line.
- A **pending** imaging order that already has attachments shows the strip too, in the existing dashed-border pending list. This is the case the user actually asked about: the film is up and viewable by the doctor *before* anyone has written a formal read.
- No upload control is added here. Uploading belongs on the worklist, which is the lab-side screen; the chart is the doctor-side read surface. Adding a second upload entry point would mean two components to keep in sync for a step the same people can already do one screen over.

## 5. Role gating summary

**There is no lab-technician role in Clinsync, and this spec does not add one.** Verified against the code, not assumed: `Role` is `admin | pi | crc | frontdesk`, and the lab subsystem already splits those four across three tiers —

| Existing lab action | Tier today | Source |
|---|---|---|
| View the worklist / `/labs` page | admin, pi, crc, frontdesk | `labs/page.tsx`, `GET /api/lab-orders` |
| Mark a sample collected | admin, pi, frontdesk | `collect/route.ts` — its own comment: *"a logistics step, not a clinical judgment"* |
| Order a test / enter a result / cancel | admin, pi | `lab-orders/route.ts`, `result/route.ts`, `cancel/route.ts` |

**Uploading an imaging file is assigned to `admin` + `pi` — the same tier that enters lab results.** The reasoning: entering a result and attaching the image *are the same act of producing the study's output*, just in two media. `pi`'s own capability text already reads "Order lab tests and manage the Lab worklist: mark samples collected, enter results, and cancel orders" (`src/lib/role-capabilities.ts`) — this is the role that already stands in for "the lab" in this app. Giving the image a wider tier than the impression would be incoherent: the file often *is* more sensitive than the sentence describing it.

This deliberately diverges from the generic `POST /api/documents` tier (`admin`, `crc`, `frontdesk` — *not* `pi`) established by the prerequisite spec, and that divergence is the reason §3b is an order-scoped route rather than a `labOrderId` parameter on the generic one. The two tiers encode two different jobs: receiving unsorted paperwork at the front desk is operations work that `pi` is deliberately excluded from, while producing a study's result is clinical work that `crc`/`frontdesk` are deliberately excluded from. Collapsing them would silently widen one or narrow the other.

| Action | Allowed | Rationale |
|---|---|---|
| Order an imaging study | admin, pi | Unchanged from every other lab order |
| Attach an image to a lab order | admin, pi | Same tier as `enterResult` — see above |
| Enter the impression / read | admin, pi | Unchanged |
| View attachment thumbnails on `/labs` | admin, pi, crc, frontdesk | Matches the worklist's existing read tier |
| View attachments on the Medical Record page | admin, pi, crc, frontdesk | Matches that page's existing access |
| Download an imaging file | admin, pi, crc, frontdesk | Inherited unchanged from the prerequisite spec's download route |
| Delete an imaging file | admin only | Inherited unchanged from the prerequisite spec's `DELETE /api/documents/[id]` |
| Mark an imaging order collected | admin, pi, frontdesk | Unchanged — and implicitly performed by admin/pi on upload (§3b step 5), which is a subset of this tier, so no privilege is widened |

`ROLE_CAPABILITIES` bullet text is updated for `admin` and `pi` to read "…mark samples collected, attach imaging results, enter results, and cancel orders", keeping that file's stated rule of describing only permissions the app actually enforces.

## 6. Testing

Following `tests/api/lab-orders-routes.test.ts`'s real-DB, `vi.mock('@/lib/auth', ...)`, mutable-`sessionRole`, `afterEach`-cleanup convention, and `tests/api/patients-insurance-card.test.ts`'s `@vitest-environment node` + `vi.mock('@vercel/blob', ...)` pattern for upload routes.

- **`tests/api/lab-orders-imaging.test.ts` (new):**
  - `admin` and `pi` can attach; `crc` and `frontdesk` each get 403.
  - Attaching to an `ordered` order creates the `documents` row **and** transitions the order to `collected` with `collectedAt` set.
  - Attaching to an already-`collected` order creates the row and leaves `status`/`collectedAt` untouched (no re-stamp — the same invariant `markCollected`'s existing test guards).
  - Attaching to a `resulted` order succeeds (addendum case).
  - Attaching to a `cancelled` order returns 409 and writes no `documents` row.
  - A non-existent order id returns 404; a non-integer id returns 400.
  - The created row has `labOrderId` set, `documentType: 'imaging_result'`, `patientId` equal to the **order's** patient, and `filedByName` equal to the session name.
  - A disallowed MIME type (e.g. `application/dicom`) is rejected 400 and calls no blob `put`.
  - An over-size file is rejected 400.
  - Two successive uploads against one order produce two rows (the multi-view case `labResults.unique()` could not express).
- **`tests/api/documents.test.ts` (extended, from the prerequisite spec):** `PATCH /api/documents/[id]` rejects `labOrderId` as an unknown field (the `.strict()` mass-assignment guard, asserting §2c's restriction rather than trusting it).
- **`tests/lib/queries/documents.test.ts` (extended):** `listImagingForOrders([])` returns an empty `Map` without issuing a query; `listImagingForOrders([a, b])` returns each order's own attachments and no other order's; an order with no attachments is simply absent from the `Map` (callers default to `[]`).
- **`tests/api/lab-orders.test.ts` (extended):** `listWorklist()` and `listOrdersForPatient()` expose `category` on every row and `attachments` as `[]` (never `null`) for an order with no images.
- **`tests/lib/queries/lab-tests.test.ts` (extended):** the catalog includes the imaging rows and every row carries a `category`; its existing `toBeGreaterThanOrEqual(10)` assertion already survives the six new seed rows unchanged, so that line is left alone rather than re-pinned to a new count.
- **`tests/api/lab-orders-routes.test.ts`:** unchanged — its existing lifecycle cases remain the regression check that adding imaging did not alter the `ordered → collected → resulted → cancelled` guards.

## 7. Migration and seed notes

`labTests.category` is added as `NOT NULL DEFAULT 'lab'`, so every existing row takes the correct value with no backfill statement — chemistry is the only thing in the catalog today. `documents.labOrderId` is added as a nullable `integer` FK with no backfill: no pre-existing document was ever associated with a lab order, so every historical row honestly keeps `NULL`. `imaging_result` is appended to `documentTypeEnum` (a Postgres `ADD VALUE`, non-breaking). The six imaging catalog rows are added to `LAB_TESTS_SEED` and picked up by the existing idempotent-by-`code` `seedLabTests()`, which needs no change and stays safe to re-run.

This spec's migration must be generated **after** the prerequisite spec's `documents` migration, since `labOrderId` and `imaging_result` both target columns and an enum that migration creates.

## 8. Open Questions

1. **Per-image captions.** §3b deliberately accepts no `notes` field, because `documents` has no column for it and overloading `name` would corrupt the download filename. In practice "lateral view" vs. "AP view" is useful, and the uploaded filename often already carries it. Options for a reviewer: leave it out (this spec's position), add a nullable `documents.note` column in this spec, or defer to a follow-up. Left out here because no one asked for it and the filename usually suffices.
2. **Correcting a mis-attached image.** §2c's structural invariant means the only correction path is admin-delete-and-re-upload. If mis-attachment turns out to be common in the pilot, the alternative is a narrow `PATCH /api/lab-orders/[id]/imaging/[documentId]` on the same admin/pi tier that can only move an attachment between two orders belonging to the same patient — cheap to add later, and deliberately not built on speculation.
3. **`frontdesk` and the upload.** Front desk can already mark a sample collected, and §3b makes the upload *perform* that collection for imaging orders — so there is a coherent argument that whoever physically handles the film should be able to upload it. This spec chooses the `enterResult` tier instead (the image is study output, not logistics), but a reviewer running the actual pilot workflow may know that the person at the machine is front-desk staff, in which case adding `frontdesk` to §3b's gate is a one-line change with no other consequences.
4. **The word "automatically."** The user asked for the image to be *"automatically uploaded from the lab itself."* Without a modality or vendor integration — explicitly out of scope, §1 — the closest honest implementation is the one-action upload in §3b: the person who took the image clicks one button on the order that requested it, and the file lands in the doctor's chart view with no filing, no patient lookup, and no second "mark collected" step. Worth confirming with the user that this is what they meant, rather than an expectation of a machine-side push that would require an integration this codebase does not have.

---

## Self-review

- **Placeholder scan:** no `TODO`/`TBD`/bracketed placeholders. Every enum value, column, route, role tier, catalog row, and test case in §2–§7 is concretely named.
- **Internal consistency:** the upload tier is stated as `admin`/`pi` identically in §3b, §4, §5, and §6, and §5's table matches every prose claim in §3–§4. The claim that the upload route diverges from the generic documents tier (§5) is the same fact used in §2c to justify not accepting `labOrderId` on the generic routes — one reason, stated once, referenced twice. §3c's "no change to `enterResult`" is consistent with §1's out-of-scope "no changes to the state machine," and §3b step 5's use of `markCollected()` is a *call to* that unchanged function, not a modification of it.
- **Scope check:** one implementation plan's worth — three additive schema changes, one new route, one extracted helper, one new query, and presentational changes to four existing components. It depends on a prerequisite spec but does not overlap it: nothing here re-specifies the blob pipeline, the download route, or the delete route.
- **Ambiguity check, resolved inline:** (a) uploading does **not** set `resulted` — it sets `collected` only from `ordered`, stated in §3b step 5 and restated in §3c; (b) `patientId` on an imaging document is derived from the order, never client-supplied (§2c, §3b step 4); (c) attachments are allowed on `resulted` orders and forbidden only on `cancelled` (§3b step 2), rather than the vaguer "only while the order is open"; (d) `category` is a catalog property, not an order property (§2a).
- **Verified against the code, not assumed:** every cited line number, role tier, and existing behavior in §1 and §5 was read out of the current `hims-platform` HEAD, not inferred. Two details only that reading surfaced, both now folded in: `LAB_TESTS_SEED`'s literal type declares `referenceRange: string` and must widen to `string | null` for imaging rows (§3a), and `tests/lib/queries/lab-tests.test.ts` asserts `toBeGreaterThanOrEqual(10)` rather than an exact catalog count, so the six new rows do not break it (§6).
- **Reuse check (the specific risk this spec was written against):** no second file-storage mechanism is introduced. Storage, download, delete, and audit are all the prerequisite spec's, and §3b explicitly requires extracting `createDocument()` so the two entry points cannot drift.
