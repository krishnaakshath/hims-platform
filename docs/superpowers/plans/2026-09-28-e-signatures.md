# E-Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize this app's one existing signing mechanism (`encounterNotes.status`/`signedAt`) into a reusable, polymorphic `signatures` table, and apply it to the two real gaps this app currently has no sign-off mechanism for: consent-category form submissions (patient-portal-initiated) and inpatient discharge summaries (staff-initiated).

**Architecture:** `signatures` is a generic, append-only event table keyed by a `(signableType, signableId)` pair rather than a widening set of nullable per-parent FKs — the same one-table-many-parents shape `auditLog` already uses in this codebase. `signableId` deliberately has **no FK**: it points at `formSubmissions.id` or `admissions.id` depending on `signableType`, and a single FK column can't target two different tables. This mirrors `auditLog.patientId`'s own loose-reference posture and avoids a table that needs a new nullable column every time a third signable thing (e.g. a future treatment-plan sign-off) is added. Consent-form signing is wired through a **patient-portal-scoped** route (`requirePatientSession()`, `logPatientPortalAction()`) — not a staff route — because the signer is the patient. Discharge signing extends the existing **staff-scoped** discharge route (`requireSession()`, `logAudit()`) in place, following this codebase's established sequential-not-transactional two-write posture (see `dischargeAdmission`'s own comment): the discharge write is the single authoritative fact and happens first; the signature insert is a second, non-blocking step whose failure never rolls back or hides the discharge.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Zod `.strict()` validation + vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-e-signatures.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/esignatures` on branch `feature/esignatures`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and every other active worktree (e.g. `.worktrees/lab-orders-results`, `.worktrees/pharmacy-med-inventory`, `.worktrees/questionnaire-scoring`) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- Every write route uses `.strict()` Zod validation.
- Every staff-initiated state-changing route calls `logAudit(session, <action>, <patientId>)`. Every patient-portal-initiated write calls `logPatientPortalAction(<action>, <patientId>)` instead — this route has no staff `Session` to give `logAudit`, and `logPatientPortalAction` is the one sanctioned place in this codebase for that.
- Every protected route/page starts with `requireSession()`/`requirePatientSession()` (API routes) or `requireSessionOrRedirect()`/`requirePatientSessionOrRedirect()` (pages) as its first statement, per which session type it belongs to.
- Role gating per spec §7: signing a consent form = the patient themself only, via patient-portal session, scoped to their own `anonId` (a mismatched `anonId` in the URL is rejected, matching `POST /api/messages/[patientId]`'s established convention of 403, not a silent no-op). Signing a discharge summary = admin, pi (no new role — matches the existing discharge route's own gate). Viewing signature status = admin, pi, crc, frontdesk (existing chart read-access precedent).
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a staff session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET` — and a patient-portal session cookie the way `src/lib/patient-session.ts` does it — `SignJWT` with `kind: 'patient'` under cookie `clinsync_patient_session`, same secret), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — this codebase's own session history includes a prior implementer fabricating UI verification evidence and being caught; do not repeat that.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).
- **Known, documented scope boundary (not a bug to silently fix):** the unauthenticated, token-based intake flow (`GET`/`PUT /api/intake/[token]`, rendered at `/intake/[token]`) is how a referred patient — who may not yet have a patient-portal account — fills out *any* form, consent-category or not, and its `complete: true` path still marks a submission `completed` directly, with no signature gate. This spec's new sign route is patient-portal-session-scoped per spec §3 and cannot be reached from that unauthenticated flow. Task 2 documents this explicitly rather than silently deciding to touch the token route (out of spec's stated scope) or silently leaving a matching implicit gap — same "record the explicit deferral" posture this session already used for the `medicationEpisodeId` dropdown in the Pharmacy plan.

## Review Focus

1. **Signing a non-consent-category form submission** — the sign route must reject based on the submission's actual template `category`, not just template existence; a non-`'Consent Forms'` template gets no signing capability at all. (Task 2)
2. **Signing an already-completed submission** — must be rejected, both on the up-front status check and via a conditional `UPDATE ... WHERE status != 'completed'` guard (matching `PUT /api/intake/[token]`'s own established re-check pattern), so a near-simultaneous second sign call can't silently re-complete or double-count. (Task 2)
3. **A patient signing a different patient's consent form via a mismatched `anonId` in the URL** — same cross-entity-forgery class this session's other plans have found and fixed; the route must reject when `session.patientId !== anonId`, matching `POST /api/messages/[patientId]`'s established 403 convention. (Task 2)
4. **Discharge succeeding even when the signature insert fails afterward** — the discharge write must never be rolled back or blocked by a downstream signature-insert failure; the medically important fact (patient discharged) stays true, and the missing signature is a visible "Not yet signed" gap on the chart, never a silently swallowed error and never a blocked discharge. (Task 3, display verified in Task 4)
5. **Missing `typedName` rejected on both signing surfaces** — a signature attestation with no typed name isn't a signature; `.strict()` Zod validation (`z.string().trim().min(1)`) must reject a missing or empty `typedName` on both the consent-sign route and the now-extended discharge route, not silently accept an empty string as "signed." (Task 2, Task 3)

---

### Task 1: Schema — `signable_type` enum, `signatures` table

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/signatures-schema.test.ts`

**Interfaces:**
- Produces: `signableTypeEnum` (`'form_submission' | 'admission_discharge'`), `signatures` table (`id, signableType, signableId, signerTypedName, signerRole, attestationText, signedAt`). Consumed by Tasks 2-4.

- [ ] **Step 1: Write the failing test**

Create `tests/db/signatures-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { signatures } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(signatures).where(eq(signatures.id, createdIds.pop()!))
})

describe('signatures schema', () => {
  it('inserts a form_submission signature with defaults', async () => {
    const [row] = await getDb().insert(signatures).values({
      signableType: 'form_submission',
      signableId: 999001, // no FK on signableId -- polymorphic, see schema.ts comment
      signerTypedName: 'Jane Patient',
      signerRole: 'patient',
      attestationText: 'I attest this is accurate.',
    }).returning()
    createdIds.push(row.id)
    expect(row.signedAt).toBeInstanceOf(Date)
  })

  it('inserts an admission_discharge signature with a different signableId of the same numeric value', async () => {
    const [row] = await getDb().insert(signatures).values({
      signableType: 'admission_discharge',
      signableId: 999001, // deliberately the same numeric id as the row above -- proves signableType, not just signableId, is part of identity
      signerTypedName: 'Dr. R. Kunam',
      signerRole: 'pi',
      attestationText: 'I attest this discharge summary is accurate and complete.',
    }).returning()
    createdIds.push(row.id)
    expect(row.signableType).toBe('admission_discharge')
  })

  it('rejects an invalid signableType', async () => {
    await expect(getDb().insert(signatures).values({
      signableType: 'not_a_real_type' as never,
      signableId: 1,
      signerTypedName: 'X',
      signerRole: 'patient',
      attestationText: 'X',
    })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/signatures-schema.test.ts`
Expected: FAIL — `signatures` isn't exported / doesn't exist.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, add near the other event-log-style table definitions (close to `auditLog` or `encounterNotes`):

```ts
export const signableTypeEnum = pgEnum('signable_type', ['form_submission', 'admission_discharge'])

// A generic, append-only signature event, keyed by (signableType, signableId)
// rather than a formSubmissionId/admissionId pair of nullable FKs -- same
// one-table-many-parents shape auditLog already uses in this codebase.
// signableId deliberately has NO FK: it means formSubmissions.id or
// admissions.id depending on signableType, and a single FK column can't
// target two different tables. This does NOT touch encounterNotes'
// existing status/signedAt signing mechanism -- that one stays as-is; see
// docs/superpowers/specs/2026-09-28-e-signatures.md §2.
export const signatures = pgTable('signatures', {
  id: serial('id').primaryKey(),
  signableType: signableTypeEnum('signable_type').notNull(),
  signableId: integer('signable_id').notNull(),
  signerTypedName: text('signer_typed_name').notNull(),
  signerRole: text('signer_role').notNull(), // free text: staff roles (admin/pi/crc/frontdesk) or 'patient' -- form-submission signatures are patient-portal-initiated, not staff
  attestationText: text('attestation_text').notNull(), // the exact attestation sentence shown at signing time, stored verbatim
  signedAt: timestamp('signed_at').defaultNow().notNull(),
})
```

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/signatures-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 5: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-signatures-scratch.ts` at this worktree's root (`/Users/k2a/Desktop/clinsync/.worktrees/esignatures`):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE signable_type AS ENUM ('form_submission', 'admission_discharge'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS signatures (
      id SERIAL PRIMARY KEY,
      signable_type signable_type NOT NULL,
      signable_id INTEGER NOT NULL,
      signer_typed_name TEXT NOT NULL,
      signer_role TEXT NOT NULL,
      attestation_text TEXT NOT NULL,
      signed_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)

  console.log('Signatures schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-signatures-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name = 'signatures'`.

Delete the scratch script once confirmed: `rm migrate-signatures-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/signatures-schema.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/signatures-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add polymorphic signatures table

EOF
)"
```

---

### Task 2: Query layer + consent-form signing route

**Files:**
- Create: `src/lib/queries/signatures.ts`
- Create: `src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts`
- Modify: `src/lib/queries/form-submissions.ts` (add `category` to `getFormSubmission`'s returned projection — the sign route needs to check the template's category, and today's projection deliberately leaves the full template row out, exposing only `templateName`/`questions`)
- Test: `tests/lib/queries/signatures.test.ts`, `tests/api/form-submission-sign.test.ts`

**Interfaces:**
- Consumes: `signatures` table (Task 1); `formSubmissions`, `formTemplates` from `@/db/schema` (existing); `getFormSubmission` from `@/lib/queries/form-submissions` (existing, modified); `requirePatientSession` from `@/lib/patient-session` (existing); `logPatientPortalAction` from `@/lib/patient-portal-audit` (existing).
- Produces: `createSignature(input)`, `getSignaturesForSignable(signableType, signableId)`, `getLatestSignatureForSignable(signableType, signableId)` from `@/lib/queries/signatures` — consumed by Tasks 3, 4. `POST /api/patients/[anonId]/form-submissions/[id]/sign` — consumed by Task 4's UI.

- [ ] **Step 1: Read `src/lib/queries/form-submissions.ts` and `getFormSubmission`'s exact current projection**

Confirm it currently returns `{ id, templateId, patientId, status, sentDate, completedDate, answers, questions, patientName }` with no `category` — the comment there explains why it's a deliberate explicit projection, not a raw row spread (it drops `accessToken`). Preserve that same explicit-projection discipline when adding `category`.

- [ ] **Step 2: Write the failing test — query layer**

Create `tests/lib/queries/signatures.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { signatures } from '@/db/schema'
import { createSignature, getSignaturesForSignable, getLatestSignatureForSignable } from '@/lib/queries/signatures'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(signatures).where(eq(signatures.id, createdIds.pop()!))
})

describe('signatures queries', () => {
  it('creates a signature and reads it back by signableType+signableId', async () => {
    const created = await createSignature({ signableType: 'form_submission', signableId: 888001, signerTypedName: 'Jane Patient', signerRole: 'patient', attestationText: 'I attest.' })
    createdIds.push(created.id)

    const rows = await getSignaturesForSignable('form_submission', 888001)
    expect(rows.some((r) => r.id === created.id)).toBe(true)

    const latest = await getLatestSignatureForSignable('form_submission', 888001)
    expect(latest?.id).toBe(created.id)
  })

  it('keeps the two signableTypes independent for the same numeric id', async () => {
    const formSig = await createSignature({ signableType: 'form_submission', signableId: 888002, signerTypedName: 'A', signerRole: 'patient', attestationText: 'x' })
    const dischargeSig = await createSignature({ signableType: 'admission_discharge', signableId: 888002, signerTypedName: 'B', signerRole: 'pi', attestationText: 'y' })
    createdIds.push(formSig.id, dischargeSig.id)

    const formRows = await getSignaturesForSignable('form_submission', 888002)
    const dischargeRows = await getSignaturesForSignable('admission_discharge', 888002)
    expect(formRows.some((r) => r.id === dischargeSig.id)).toBe(false)
    expect(dischargeRows.some((r) => r.id === formSig.id)).toBe(false)
  })

  it('returns null from getLatestSignatureForSignable when none exists', async () => {
    const latest = await getLatestSignatureForSignable('admission_discharge', 999999999)
    expect(latest).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/signatures.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `src/lib/queries/signatures.ts`**

```ts
import { getDb } from '@/db/client'
import { signatures } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'

export type Signature = typeof signatures.$inferSelect
export type SignableType = 'form_submission' | 'admission_discharge'

export interface CreateSignatureInput {
  signableType: SignableType
  signableId: number
  signerTypedName: string
  signerRole: string
  attestationText: string
}

export async function createSignature(input: CreateSignatureInput): Promise<Signature> {
  const [created] = await getDb().insert(signatures).values(input).returning()
  return created
}

export async function getSignaturesForSignable(signableType: SignableType, signableId: number): Promise<Signature[]> {
  return getDb().select().from(signatures)
    .where(and(eq(signatures.signableType, signableType), eq(signatures.signableId, signableId)))
    .orderBy(desc(signatures.signedAt))
}

export async function getLatestSignatureForSignable(signableType: SignableType, signableId: number): Promise<Signature | null> {
  const rows = await getSignaturesForSignable(signableType, signableId)
  return rows[0] ?? null
}
```

- [ ] **Step 5: Run the query-layer test to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/signatures.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add `category` to `getFormSubmission`'s projection**

In `src/lib/queries/form-submissions.ts`, add `category: row.template.category` to the object `getFormSubmission` returns (the join already selects the full `formTemplates` row as `template` — no query shape change needed, just the projection). Do not add it to `listFormSubmissions`'s projection — nothing in this plan needs it there, and the same explicit-projection discipline means only adding what's actually consumed.

- [ ] **Step 7: Write the failing test — consent-form sign route**

Create `tests/api/form-submission-sign.test.ts`. Set up two throwaway `formTemplates` rows (one `category: 'Consent Forms'`, one `category: 'Screening Questionnaires'`) and `formSubmissions` rows against a real seeded patient, cleaned up in `afterEach`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { POST } from '@/app/api/patients/[anonId]/form-submissions/[id]/sign/route'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, signatures } from '@/db/schema'

const PATIENT_ID = 'RD-0001' // seeded real patient

let sessionPatientId: string | null = PATIENT_ID
vi.mock('@/lib/patient-session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/patient-session')>('@/lib/patient-session')
  return {
    ...actual,
    requirePatientSession: vi.fn(async () =>
      sessionPatientId ? { patientId: sessionPatientId } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ),
  }
})

const createdTemplateIds: number[] = []
const createdSubmissionIds: number[] = []
afterEach(async () => {
  sessionPatientId = PATIENT_ID
  while (createdSubmissionIds.length > 0) {
    const id = createdSubmissionIds.pop()!
    await getDb().delete(signatures).where(eq(signatures.signableId, id))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

async function makeSubmission(category: string, status: 'sent' | 'partial' | 'completed' = 'partial') {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({ name: `Test ${category} ${Date.now()}`, category, diagnosisTag: 'test', questions: [] }).returning()
  createdTemplateIds.push(template.id)
  const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: PATIENT_ID, status }).returning()
  createdSubmissionIds.push(submission.id)
  return submission
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients/[anonId]/form-submissions/[id]/sign', () => {
  it('signs a consent-category submission and marks it completed', async () => {
    const submission = await makeSubmission('Consent Forms')
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(200)

    const [updated] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(updated.status).toBe('completed')
    const sigRows = await getDb().select().from(signatures).where(eq(signatures.signableId, submission.id))
    expect(sigRows.some((s) => s.signableType === 'form_submission' && s.signerTypedName === 'Maria Alvarez')).toBe(true)
  })

  it('rejects a non-consent-category template', async () => {
    const submission = await makeSubmission('Screening Questionnaires')
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(400)
    const [unchanged] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(unchanged.status).toBe('partial')
  })

  it('rejects an already-completed submission', async () => {
    const submission = await makeSubmission('Consent Forms', 'completed')
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(409)
  })

  it('rejects a missing typedName', async () => {
    const submission = await makeSubmission('Consent Forms')
    const res = await POST(req({}) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(400)
  })

  it('rejects signing through a mismatched anonId', async () => {
    const submission = await makeSubmission('Consent Forms')
    const res = await POST(req({ typedName: 'Someone Else' }) as never, { params: Promise.resolve({ anonId: 'RD-0002', id: String(submission.id) }) })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-submission-sign.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 9: Implement the route**

Create `src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { requirePatientSession } from '@/lib/patient-session'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { getFormSubmission } from '@/lib/queries/form-submissions'
import { createSignature } from '@/lib/queries/signatures'

const signSchema = z.object({ typedName: z.string().trim().min(1) }).strict()

const CONSENT_ATTESTATION = 'I attest that the information in this form is accurate and I consent to the terms described above.'

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string; id: string }> }) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const { anonId, id } = await params
  // Same convention as POST /api/messages/[patientId]: a patient session
  // that doesn't match the URL's patientId is a distinct 403, not a silent
  // 401 or a no-op -- it never confirms or denies that a submission with
  // this id exists for a *different* patient.
  if (session.patientId !== anonId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = signSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid signature payload', details: parsed.error.flatten() }, { status: 400 })

  const submissionId = Number(id)
  const submission = await getFormSubmission(submissionId)
  if (!submission || submission.patientId !== anonId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (submission.category !== 'Consent Forms') return NextResponse.json({ error: 'This form does not require a signature' }, { status: 400 })
  if (submission.status === 'completed') return NextResponse.json({ error: 'This form has already been completed' }, { status: 409 })

  // Insert the signature FIRST, then a conditional UPDATE guarded by
  // status != 'completed' -- same sequential, non-transactional two-write
  // posture already established for admissions.ts's transferAdmission/
  // dischargeAdmission (this driver doesn't support multi-statement
  // transactions). If two sign calls race, at most one UPDATE succeeds (the
  // WHERE guard); the loser gets a 409 below. A signature row is never
  // deleted or rolled back once inserted -- same append-only posture as the
  // rest of this table -- so the astronomically rare raced duplicate
  // attestation is left in place rather than silently discarded.
  await createSignature({
    signableType: 'form_submission',
    signableId: submissionId,
    signerTypedName: parsed.data.typedName,
    signerRole: 'patient',
    attestationText: CONSENT_ATTESTATION,
  })

  const updated = await getDb().update(formSubmissions)
    .set({ status: 'completed', completedDate: new Date() })
    .where(and(eq(formSubmissions.id, submissionId), ne(formSubmissions.status, 'completed')))
    .returning({ id: formSubmissions.id })
  if (updated.length === 0) return NextResponse.json({ error: 'This form has already been completed' }, { status: 409 })

  await logPatientPortalAction('signed consent form', anonId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 10: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/signatures.test.ts tests/api/form-submission-sign.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/signatures.ts src/lib/queries/form-submissions.ts "src/app/api/patients/[anonId]/form-submissions" tests/lib/queries/signatures.test.ts tests/api/form-submission-sign.test.ts
git commit -m "$(cat <<'EOF'
feat: add signatures query layer and patient-portal consent-form signing route

EOF
)"
```

---

### Task 3: Discharge signing

**Files:**
- Modify: `src/app/api/inpatient/admissions/[id]/discharge/route.ts`
- Modify: `tests/api/inpatient-admissions-discharge.test.ts` (extend, don't duplicate its setup, per spec §6)

**Interfaces:**
- Consumes: `createSignature` from `@/lib/queries/signatures` (Task 2).
- Produces: a `signatures` row (`signableType: 'admission_discharge'`) inserted alongside every successful discharge — consumed by Task 4's display.

- [ ] **Step 1: Read the full existing discharge route and its full existing test file**

Read `src/app/api/inpatient/admissions/[id]/discharge/route.ts` (already read during planning — reconfirm its current shape hasn't drifted) and the **entire** `tests/api/inpatient-admissions-discharge.test.ts` file. `typedName` is about to become a required field on `dischargeSchema`; every existing test in that file that currently POSTs a *successful* discharge body will start failing once that lands unless its body also gains a `typedName`. Inventory every such test now, before writing new ones, so Step 2 updates all of them in the same pass.

- [ ] **Step 2: Write the failing tests**

In `tests/api/inpatient-admissions-discharge.test.ts`:
- Add `typedName: 'Dr. Chen'` (or the test's existing session name) to every existing request body that currently expects a 200/success response.
- Add a new test: a discharge request body missing `typedName` (all other required fields present) is rejected with 400.
- Add a new test: a successful discharge with `typedName` present also inserts a `signatures` row — query `signatures` directly (`signableType: 'admission_discharge', signableId: admission.id`) and assert `signerTypedName` matches what was sent. Import `signatures` from `@/db/schema` and clean it up in `afterEach` alongside the existing admission/appointment cleanup.
- Add a new test for Review Focus #4: mock `@/lib/queries/signatures` (`vi.mock('@/lib/queries/signatures', () => ({ createSignature: vi.fn(async () => { throw new Error('simulated signature insert failure') } ) }))`) and confirm a discharge with a valid `typedName` still returns 200/`ok: true` and the admission is still actually discharged (`status: 'discharged'` in the DB) even though the signature insert threw — the discharge must never be rolled back or fail because of a downstream signature error.

- [ ] **Step 3: Run them to confirm the expected failures**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-admissions-discharge.test.ts`
Expected: the new "creates a signature row" test FAILs (no `signatures` row exists yet — `typedName` isn't even part of the schema, so it's currently silently ignored as an extra field... except `.strict()` means an unrecognized key is actually *rejected* — confirm whether pre-existing tests newly sending `typedName` now unexpectedly fail with 400 due to `.strict()` rejecting the not-yet-declared key; if so that's the correct, expected pre-implementation failure). The "missing typedName rejected" test currently unexpectedly PASSes as a 200 (no gate exists yet) — expected to fail red for the right reason (it's asserting 400, gets 200).

- [ ] **Step 4: Implement**

In `src/app/api/inpatient/admissions/[id]/discharge/route.ts`:

Add `createSignature` to the imports and a `DISCHARGE_ATTESTATION` constant. Add `typedName: z.string().trim().min(1)` to `dischargeSchema` (still `.strict()`). After the existing `await logAudit(session, 'discharged patient', admission.patientId)` line and before the `return`, add:

```ts
const DISCHARGE_ATTESTATION = 'I attest that this discharge summary is accurate and complete.'

// ...

  await logAudit(session, 'discharged patient', admission.patientId)

  // Insert the discharge signature as a SEPARATE step after the
  // authoritative discharge write above -- same sequential-not-transactional
  // posture dischargeAdmission itself already documents for its own
  // room-freeing/follow-up-appointment steps (this driver has no
  // multi-statement transactions). If this insert throws, the admission is
  // already correctly discharged -- the medically important fact -- and the
  // missing signature is left as a genuine, visible "Not yet signed" gap on
  // the chart (Task 4) rather than a silently swallowed error or a blocked
  // discharge.
  try {
    await createSignature({
      signableType: 'admission_discharge',
      signableId: admissionId,
      signerTypedName: parsed.data.typedName,
      signerRole: session.role,
      attestationText: DISCHARGE_ATTESTATION,
    })
  } catch (err) {
    console.error(`Failed to record discharge signature for admission ${admissionId}:`, err)
  }

  return NextResponse.json({ ok: true, followUpAppointmentId: result.followUpAppointmentId ?? null })
```

- [ ] **Step 5: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-admissions-discharge.test.ts`
Expected: PASS (all tests, including every pre-existing one now sending `typedName`).

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/inpatient/admissions/[id]/discharge/route.ts" tests/api/inpatient-admissions-discharge.test.ts
git commit -m "$(cat <<'EOF'
feat: require a typed signature on inpatient discharge

EOF
)"
```

---

### Task 4: Display + reusable `<SignatureCapture>` component

**Files:**
- Create: `src/components/SignatureCapture.tsx`
- Create: `src/components/SignConsentFormAction.tsx`
- Modify: `src/components/DischargeAdmissionModal.tsx` (wire `<SignatureCapture>` into the followup/submit step, send `typedName` in the discharge POST body)
- Modify: `src/components/InpatientHistoryPanel.tsx` (show "Signed by X on Y" / "Not yet signed" for discharged admissions)
- Modify: `src/lib/queries/admissions.ts` (`listAdmissionsForPatient` attaches each discharged admission's latest discharge signature)
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx` (pass the new signature field through to `InpatientHistoryPanel`)
- Modify: `src/lib/queries/patient-portal.ts` (`getPatientPortalData`'s `forms` select gains `category`)
- Modify: `src/app/patient-portal/(authenticated)/forms/page.tsx` (render `<SignConsentFormAction>` for non-completed, `'Consent Forms'`-category submissions)
- Test: none new (UI wiring over already-tested routes) — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `getLatestSignatureForSignable` (Task 2), `POST /api/inpatient/admissions/[id]/discharge` (Task 3, called by URL), `POST /api/patients/[anonId]/form-submissions/[id]/sign` (Task 2, called by URL).

- [ ] **Step 1: Build the reusable `<SignatureCapture>` component**

Create `src/components/SignatureCapture.tsx` (`'use client'`) — a purely presentational, controlled input widget: a typed-full-legal-name text input, an attestation `<input type="checkbox">` with the attestation sentence as its label (no dedicated `Checkbox` UI primitive exists in this codebase — `src/components/ui/` has no `checkbox.tsx` — a plain `<input type="checkbox">` matches the codebase's existing convention, e.g. `FormBuilderEditor.tsx`), and a submit `Button` disabled until both a non-empty typed name and the checkbox are present. It does **not** perform the fetch itself — the parent (discharge modal, consent-sign action) owns the request/submitting/error state and passes `onSign(typedName)`, `submitting`, and `error` down, matching how every other action-modal in this codebase (`DischargeAdmissionModal`, `DispenseMedicationModal`) owns its own fetch rather than delegating it to a sub-component:

```tsx
'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function SignatureCapture({
  attestationLabel,
  submitLabel = 'Sign',
  submitting = false,
  error = null,
  onSign,
}: {
  attestationLabel: string
  submitLabel?: string
  submitting?: boolean
  error?: string | null
  onSign: (typedName: string) => void
}) {
  const [typedName, setTypedName] = useState('')
  const [attested, setAttested] = useState(false)
  const canSubmit = typedName.trim().length > 0 && attested && !submitting

  return (
    <div className="space-y-2">
      <label htmlFor="signature-typed-name" className="block text-xs font-medium text-muted-foreground">
        Type your full legal name to sign
      </label>
      <input
        id="signature-typed-name"
        value={typedName}
        onChange={(e) => setTypedName(e.target.value)}
        placeholder="Full legal name"
        aria-label="Typed signature"
        className="w-full rounded-md border border-border px-3 py-2 text-sm"
      />
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} aria-label="Attestation" className="mt-0.5" />
        <span>{attestationLabel}</span>
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button size="sm" onClick={() => onSign(typedName.trim())} disabled={!canSubmit}>{submitLabel}</Button>
    </div>
  )
}
```

- [ ] **Step 2: Wire `<SignatureCapture>` into `DischargeAdmissionModal`**

Read `src/components/DischargeAdmissionModal.tsx`'s current state (already read during planning — reconfirm it hasn't drifted). In the `'followup'` step: replace the plain `<Button onClick={submit}>Discharge</Button>` in `DialogFooter` with `<SignatureCapture attestationLabel="I attest that this discharge summary is accurate and complete." submitLabel="Discharge" submitting={submitting} error={error} onSign={submit} />` rendered in the step body (not the footer — it has its own submit button), and keep only the "Back" button in the footer for that step. Change `submit` to accept `(typedName: string)` and include `typedName` in the POST body's JSON.

- [ ] **Step 3: Show discharge-signature status in the chart**

In `src/lib/queries/admissions.ts`, extend `listAdmissionsForPatient`: for each admission with `status === 'discharged'`, call `getLatestSignatureForSignable('admission_discharge', admission.id)` and attach it as `dischargeSignature: { signerTypedName: string; signedAt: Date } | null` on the returned row (admitted admissions get `dischargeSignature: null` without a query, since they have no discharge yet).

In `src/components/InpatientHistoryPanel.tsx`, extend `AdmissionRecord` with `dischargeSignature: { signerTypedName: string; signedAt: string } | null`, and in the `a.status === 'discharged'` block add, before or alongside the existing diagnosis/drugs/devices/diet grid:

```tsx
<p className="mb-2 text-xs">
  {a.dischargeSignature
    ? <span className="text-success">Signed by {a.dischargeSignature.signerTypedName} on {new Date(a.dischargeSignature.signedAt).toLocaleDateString()}</span>
    : <span className="font-medium text-destructive">Not yet signed</span>}
</p>
```

Read `src/app/(dashboard)/patients/[anonId]/page.tsx`'s current mapping from `listAdmissionsForPatient`'s rows into the `admissions` prop it passes to `InpatientHistoryPanel` (dates are serialized to strings there) and add `dischargeSignature` to that mapping consistently with how the other fields are already handled.

- [ ] **Step 4: Wire consent-form signing into the patient portal**

In `src/lib/queries/patient-portal.ts`, add `category: formTemplates.category` to `getPatientPortalData`'s `forms` select.

Create `src/components/SignConsentFormAction.tsx` (`'use client'`): takes `{ formSubmissionId: number }`, owns its own `submitting`/`error` state, `POST`s to `/api/patients/[anonId]/form-submissions/[id]/sign` (the patient's own `anonId` — read it from the current page via a prop, don't infer it client-side), `router.refresh()` on success.

In `src/app/patient-portal/(authenticated)/forms/page.tsx`, for each form where `f.category === 'Consent Forms' && f.status !== 'completed'`, render `<SignConsentFormAction patientId={session.patientId} formSubmissionId={f.id} />` alongside the existing status pill / Start-Continue link.

Note in the report: the unauthenticated `/intake/[token]` token flow (used before a patient has a portal account) is left unchanged per this plan's documented scope boundary (Global Constraints) — a consent form completed entirely through that flow, without ever visiting the authenticated portal, has no signature and will show as unsigned wherever this plan adds signature display. This plan does not add a signature-status display to the forms list itself (the spec's §5 display requirement is scoped to the discharge summary view); the sign action's own success/already-completed state is the only feedback surface here.

- [ ] **Step 5: Verify via a real running dev server, not narration**

Staff side: real login (mint `clinsync_demo_session` per Global Constraints), real discharge of a real admitted patient via the modal's route including `typedName`, real reload of that patient's chart page, confirm "Signed by <name> on <date>" renders. Then discharge a second admission via a direct `curl` POST to the discharge route with `typedName` omitted, confirm 400.

Patient-portal side: real login to the patient portal (mint `clinsync_patient_session` per Global Constraints), real GET of `/patient-portal/forms`, real sign of a consent-category submission via the new route, confirm it now shows `completed`. Paste actual commands and actual output for both.

- [ ] **Step 6: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/SignatureCapture.tsx src/components/SignConsentFormAction.tsx src/components/DischargeAdmissionModal.tsx src/components/InpatientHistoryPanel.tsx src/lib/queries/admissions.ts "src/app/(dashboard)/patients/[anonId]/page.tsx" src/lib/queries/patient-portal.ts "src/app/patient-portal/(authenticated)/forms/page.tsx"
git commit -m "$(cat <<'EOF'
feat: add SignatureCapture component and wire it into discharge and consent-form signing

EOF
)"
```
