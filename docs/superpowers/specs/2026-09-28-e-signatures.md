# E-Signatures — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — a general, reusable signature-capture capability, extracted from the ad-hoc pattern already used once (encounter note signing) and applied to two real gaps this app currently has no sign-off mechanism for.

## 1. What this is, and the boundary it works within

This app already has exactly one signing mechanism: `encounterNotes.status`/`signedAt`, set by a one-off `signNote()` function tightly coupled to that one table. This spec generalizes that into a reusable capability and applies it to two places that need a signature and currently don't have one: **consent-category form submissions** (a patient should attest to a consent form, not just submit answers) and **discharge summaries** (an admission's discharge summary currently has free-text fields but nothing marking it as attested/final by the attending).

This is a **typed-attestation** signature (full legal name typed + an explicit "I attest this is accurate" checkbox + timestamp + signer identity), matching the exact mechanism this app's own encounter-note signing already uses and that real lightweight e-signature products (DocuSign's "type to sign" option, not just draw-to-sign) treat as legally equivalent for internal clinical workflows. **Explicitly out of scope:** drawn/canvas signatures (a real, valuable UI feature, but its own scope — this spec's typed-attestation mechanism is the same legal category, just a different input widget, and nothing here blocks adding a canvas option later as an alternative input to the same `signatures` table). Signature image/biometric capture, notarization, or any DocuSign-style third-party e-signature vendor integration (needs a real vendor relationship, same "needs a real business/regulatory step" boundary already established elsewhere in this codebase for e-prescribing and real insurance clearinghouse connectivity).

This spec adds:
1. A **`signatures`** table — polymorphic (a `signableType` + `signableId` pair, not a new FK per use), one row per signature event: signer name/role, typed attestation text, timestamp.
2. Wiring `formSubmissions` completion for **consent-category templates** (`formTemplates.category = 'Consent Forms'`, the category value this app's seed data already uses) to require a signature before the submission can be marked `completed`.
3. Wiring `admissions` discharge to require the attending's signature before `dischargedAt` can be set — extending the existing discharge route, not replacing it.
4. A small reusable `<SignatureCapture>` component (typed-name input + attestation checkbox + submit) used in both places.

## 2. Data model changes (additive only)

```ts
export const signableTypeEnum = pgEnum('signable_type', ['form_submission', 'admission_discharge'])

export const signatures = pgTable('signatures', {
  id: serial('id').primaryKey(),
  signableType: signableTypeEnum('signable_type').notNull(),
  signableId: integer('signable_id').notNull(), // formSubmissions.id or admissions.id, per signableType -- no FK (polymorphic, matches this codebase's existing posture of not forcing a single FK across heterogeneous parents)
  signerTypedName: text('signer_typed_name').notNull(),
  signerRole: text('signer_role').notNull(), // free text: covers both staff roles (admin/pi/crc/frontdesk) and 'patient' (form-submission signatures are patient-portal-initiated, not staff)
  attestationText: text('attestation_text').notNull(), // the exact attestation sentence shown at signing time, stored verbatim so a later audit sees exactly what was agreed to, even if the UI's wording changes later
  signedAt: timestamp('signed_at').defaultNow().notNull(),
})
```

**Why polymorphic (`signableType`/`signableId`) rather than a `formSubmissionId`/`admissionId` pair of nullable FKs:** this is the same one-table-many-parents shape `auditLog` already uses in this codebase (a generic event log keyed by loose reference rather than a wide table of nullable FKs per possible parent) — consistent with existing convention, and avoids a table that grows a new nullable column every time a third signable thing is added later.

**Why this does NOT touch `encounterNotes.status`/`signedAt`:** that mechanism already works, is already tested, and migrating it to the new table is a real refactor with its own risk/review surface — out of scope for this spec. The two are allowed to coexist; a future cleanup spec can consolidate if desired, but this spec doesn't force it.

## 3. Consent form signing

`POST /api/patients/[anonId]/form-submissions/[id]/sign` (patient-portal-scoped, matching the existing `logPatientPortalAction` vs `logAudit` split already established in this codebase) — body `{ typedName: string }`. Validates the submission's template is `category = 'Consent Forms'` and `status != 'completed'` yet, inserts a `signatures` row (`signableType: 'form_submission'`), and only then updates `formSubmissions.status` to `'completed'`. A non-consent-category template's completion flow is unchanged (no signature required, existing behavior preserved) — this spec adds a gate, it doesn't change how every other form completes.

## 4. Discharge signing

Extends the existing discharge route (`POST /api/inpatient/admissions/[id]/discharge`, already role-gated to the attending `pi` or `admin`, per prior session work) to require `{ ..., typedName: string }` in its body when the admission's `discharge*` fields are being finalized. Inserts a `signatures` row (`signableType: 'admission_discharge'`) in the same transaction-adjacent step as setting `dischargedAt` (matching this codebase's existing non-transactional two-write convention — no `db.transaction()` usage exists anywhere in this query layer today, and introducing one here would be a novel pattern for a single spec to decide unilaterally). If the signature insert fails after the discharge write succeeds, the admission is still correctly discharged (the medically important fact), and the missing signature is visible as a genuine gap on the admission's chart view (§5) rather than silently hidden — matches the "a human confirms, software never pretends a fact is true when it isn't" principle already applied elsewhere in this codebase (e.g. the deliberately-not-transactional risk this repo's Pharmacy final review already accepted a mitigation for, and to be honest about here rather than re-litigate).

## 5. Display

The discharge summary view (wherever `admissions.dischargeSummaryNotes` etc. are currently shown) gains a small "Signed by Dr. X on <date>" line when a `signatures` row exists for that admission, or a visible "Not yet signed" indicator when it doesn't — never silently blank.

## 6. Testing

`tests/lib/queries/signatures.test.ts` (create/read, polymorphic lookup by type+id), `tests/api/form-submission-sign.test.ts` (signing a consent-category submission marks it completed; signing a non-consent-category submission is rejected — no such capability offered; signing an already-completed submission is rejected; signing without `typedName` is rejected), `tests/api/discharge-signature.test.ts` (discharge without `typedName` is rejected when the admission's template requires it — extends the existing discharge test file rather than duplicating its setup).

## 7. Role gating summary

| Action | Allowed |
|---|---|
| Sign a consent form | The patient themself, via patient-portal session only (matches existing patient-portal write conventions) |
| Sign a discharge summary | admin, pi (matches the existing discharge route's own gate — no new role introduced) |
| View signature status | admin, pi, crc, frontdesk (matches existing chart read-access precedent) |
