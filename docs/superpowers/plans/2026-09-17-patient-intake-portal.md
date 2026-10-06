# Patient Intake Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give referred patients an actual page to fill out an intake form themselves — reachable without a staff login, auto-filling whatever the practice already knows about them, so they only answer what's genuinely new. Today, "Send Form to Client" only creates a database row; no patient-facing page exists anywhere in the app.

**Architecture:** A single-use, time-limited access token generated when a form is sent, carried in a public URL (`/intake/[token]`). This route sits outside the `(dashboard)` route group and outside `proxy.ts`'s staff-session check — it has its own, narrower authorization model (possession of an unguessable token, not a staff session) and exposes only the minimum data needed for that one form, never the rest of the patient's chart.

**Tech Stack:** Same as the rest of the app — Next.js App Router, Drizzle/Neon, Zod validation. No new external dependencies.

**Spec:** This document (design section below) — no separate spec file; the design is small enough to travel with the plan.

## Design & Security Model

**Why this needs its own authorization model.** Every other page in this app requires a staff session (`requireSessionOrRedirect()`/`requireSession()`), because every other user is a CRC, PI, or Admin who logged in. A referred patient has no such account and never will — the whole point of "sending them a form" is that they access it without one. That means this feature is a deliberate, narrow exception to "every route requires a session," not a bug to fix later. It must be *more* careful about what it exposes, not less, precisely because it has no login to gate on.

**Token, not a login.** When a CRC sends a form (`POST /api/form-submissions`, already built in Phase 1), generate a cryptographically random 32-byte token (`crypto.randomBytes(32).toString('base64url')` — 256 bits of entropy, computationally infeasible to guess or enumerate) and store it on that specific `formSubmissions` row. The token is the patient's only credential. It is:
- **Scoped to exactly one form submission** — it never grants access to the patient's chart, other trial data, screening verdicts, or any other patient's data. Only the fields this specific form's questions need, plus enough identity info for the patient to confirm "this is me."
- **Time-limited** — expires 30 days after it was sent (`tokenExpiresAt`), matching how a real intake-form link would go stale.
- **Single-purpose** — once the submission's status becomes `'completed'`, the token stops accepting further edits (a stale, possibly-forwarded link can't be used to tamper with an already-submitted form). A `'partial'` submission's token stays valid so the patient can resume.

**What the page shows.** Known-good practice: never make a patient re-type what the practice already has on file. Each question in a `formTemplates` row can optionally carry an `autofillField` tag (`'name' | 'dob' | 'email' | 'phone' | null`). When the portal renders a question tagged this way, it pre-fills the input from the patient's existing `nameIntakeq`/`dobIntakeq`/`emailIntakeq`/`phoneIntakeq` — editable, not locked, since the patient is the authority on their own current contact info even if the chart is stale. Untagged questions render blank, exactly as today's staff-facing form view already renders them.

**Audit trail for a patient's own actions.** `logAudit()` deliberately requires a real, non-null `Session` — that guarantee must not be weakened, since it's what stops a fabricated audit entry from ever being attributed to a real staff member. A patient completing their own form is a genuinely different kind of event with no `Session` behind it. Add one narrow, explicitly-named function, `logPatientPortalAction()`, that writes an audit row with `userName: 'Patient (self-service)'` and a `null` role (requires making `auditLog.role` nullable — existing rows are unaffected, they keep their real role). This is the *only* place in the codebase permitted to write a null-role audit row; every other call site still goes through `logAudit()` and still requires a real session.

**`proxy.ts` must explicitly allow this path.** The current matcher (`['/((?!api|_next/static|_next/image|favicon.ico).*)']`) matches everything except API routes and static assets — meaning `/intake/[token]` would currently get force-redirected to the staff `/login` page, since a patient has no session cookie. The matcher must be updated to also exclude `/intake`.

**What this explicitly does not do:** no patient account/password, no "forgot my link" self-service resend (a CRC re-sends from the staff side if a link is lost), no file uploads, no editing of anything beyond this one form's own questions.

## Global Constraints

- `.strict()` Zod validation on the token-gated PUT route, exactly like every other write in this app.
- Zero decorative icons, design tokens only (`bg-primary`, `bg-accent`, `border-border`, etc.) — but the portal's own layout is intentionally NOT the staff dashboard chrome (no `LeftNav`, no `TopBanner`, no audit-log visibility) since a patient should see a plain, focused form, not an internal tool's shell.
- Never expose `idNumberEncrypted`, diagnoses, medications, allergies, screening verdicts, or any patient field the specific question set doesn't need.
- No new external dependencies.
- Never name "IntakeQ"/"Tebra" in any user-facing string this plan adds — this product doesn't refer to the systems it was originally modeled on.

---

### Task 1: Schema — access token + expiry on form submissions, autofill tagging on templates, nullable audit role

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/seed.test.ts` (existing — extend if it asserts specific column sets)

**Interfaces:**
- Produces: `formSubmissions.accessToken` (text, unique, nullable — null for the pre-portal submissions that already exist before this migration runs), `formSubmissions.tokenExpiresAt` (timestamp, nullable), `formTemplates.questions[].autofillField` (optional field on the existing JSONB question shape), `auditLog.role` becomes nullable.

- [ ] **Step 1: Extend `formSubmissions` and `formTemplates` in `src/db/schema.ts`**

Add two columns to the existing `formSubmissions` table definition:

```typescript
  accessToken: text('access_token').unique(),
  tokenExpiresAt: timestamp('token_expires_at'),
```

Extend the `questions` JSONB type on `formTemplates` (find the existing `.$type<{...}[]>()` definition) to add one optional field to each question's shape:

```typescript
    autofillField: 'name' | 'dob' | 'email' | 'phone' | null
```

(Add it as an optional property in the existing inline type literal — e.g. `autofillField?: 'name' | 'dob' | 'email' | 'phone' | null`.)

- [ ] **Step 2: Make `auditLog.role` nullable**

Find `export const auditLog = pgTable(...)` and change `role: roleEnum('role').notNull()` to `role: roleEnum('role')` (drop `.notNull()`). Existing rows are unaffected — this only permits new rows to omit a role.

- [ ] **Step 3: Push schema and generate migration**

```bash
npm run db:push
npm run db:generate
```

Confirm the generated migration file adds the two new columns, the JSONB type change (no-op at the SQL level, JSONB has no fixed shape), and drops the NOT NULL constraint on `audit_log.role`. Commit the migration files.

- [ ] **Step 4: Backfill existing seed templates with `autofillField` tags**

In `src/db/seed.ts`, find the existing form template definitions (MDD/ADHD/consent/screening templates from Phase 1). For each question whose label is clearly a name/DOB/email/phone field (e.g. "Full legal name", "Date of birth"), add the matching `autofillField` tag. Leave clinical/consent questions untagged (`autofillField` omitted or `null`).

- [ ] **Step 5: Re-seed and verify**

```bash
npm run db:seed
```

Run: `npx dotenv -e .env.local -- npx tsx -e "import { getDb } from './src/db/client'; import { formTemplates } from './src/db/schema'; getDb().select().from(formTemplates).then(r => console.log(JSON.stringify(r.map(t => t.questions), null, 2)))"` and confirm at least one template's questions show `autofillField` tags on the expected ones.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts drizzle/
git commit -m "feat: add access-token and autofill-tagging schema for the patient intake portal"
```

---

### Task 2: Token generation on send, and `logPatientPortalAction`

**Files:**
- Modify: `src/app/api/form-submissions/route.ts` (the existing `POST` handler)
- Create: `src/lib/patient-portal-audit.ts`
- Test: `tests/api/form-submissions.test.ts` (existing — extend)

**Interfaces:**
- Consumes: `formSubmissions.accessToken`/`tokenExpiresAt` (Task 1).
- Produces: `logPatientPortalAction(action: string, patientId: string, details?: string): Promise<void>`, consumed by Task 4's token-gated PUT route.

- [ ] **Step 1: `src/lib/patient-portal-audit.ts`**

```typescript
import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'

// The ONE sanctioned place in this codebase that writes an audit row with no
// real Session behind it. A patient filling out their own intake form has no
// staff session -- that's the entire point of this feature -- so it cannot
// go through logAudit(), which deliberately requires one. Every other write
// in this app still must go through logAudit() with a real session; this
// function exists so that requirement is never silently bypassed anywhere
// else, only here, for exactly this one legitimate case.
export async function logPatientPortalAction(action: string, patientId: string, details?: string): Promise<void> {
  await getDb().insert(auditLog).values({
    userName: 'Patient (self-service)',
    role: null,
    action,
    patientId,
    details,
  })
}
```

- [ ] **Step 2: Generate a token when a form is sent**

Read `src/app/api/form-submissions/route.ts` in full first. In the `POST` handler, after validating the request body and before inserting, generate the token and expiry:

```typescript
import { randomBytes } from 'crypto'
// ...
const accessToken = randomBytes(32).toString('base64url')
const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
```

Add `accessToken` and `tokenExpiresAt` to the `.values({...})` object in the existing insert call, alongside the existing fields. Do not change the route's Zod input schema — the token is server-generated, never client-supplied.

- [ ] **Step 3: Test**

Add to `tests/api/form-submissions.test.ts` (read the existing file first, add alongside its current tests):

```typescript
it('generates a unique access token and a 30-day expiry when a form is sent', async () => {
  const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId: 1, patientId: 'RD-0001' }) })
  const res = await POST(req as never)
  const body = await res.json()
  expect(body.accessToken).toBeTruthy()
  expect(typeof body.accessToken).toBe('string')
  expect(body.accessToken.length).toBeGreaterThan(30)
  expect(new Date(body.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now())
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/patient-portal-audit.ts src/app/api/form-submissions/route.ts tests/api/form-submissions.test.ts
git commit -m "feat: generate a single-use access token when an intake form is sent"
```

---

### Task 3: Allow `/intake` through `proxy.ts`

**Files:**
- Modify: `src/proxy.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `/intake/*` reachable without a staff session, consumed by Task 4/5's routes and page.

- [ ] **Step 1: Update the matcher**

Read `src/proxy.ts` in full. Its current `config.matcher` is `['/((?!api|_next/static|_next/image|favicon.ico).*)']`. Change it to also exclude `/intake`:

```typescript
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico|intake).*)'] }
```

Do not change anything else in this file — the cookie-validation logic for every other path is unaffected and must stay exactly as-is.

- [ ] **Step 2: Test**

If `tests/` has an existing test for `proxy.ts`'s matcher/redirect behavior, read it and add a case confirming a request to `/intake/anything` is NOT redirected (passes through). If no such test file exists, skip adding one — this is a one-line config change with low regression risk, and Task 5's manual verification will exercise it directly.

- [ ] **Step 3: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/proxy.ts
git commit -m "feat: allow the patient intake portal through the staff-session proxy check"
```

---

### Task 4: Token-gated API — `GET`/`PUT /api/intake/[token]`

**Files:**
- Create: `src/lib/queries/intake-portal.ts`
- Create: `src/app/api/intake/[token]/route.ts`
- Test: `tests/api/intake-portal.test.ts`

**Interfaces:**
- Consumes: `logPatientPortalAction` (Task 2).
- Produces: `getIntakePortalData(token: string)`, consumed by Task 5's page; `PUT /api/intake/[token]`, consumed by Task 5's client component.

- [ ] **Step 1: `src/lib/queries/intake-portal.ts`**

```typescript
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'

export type IntakePortalState = 'active' | 'expired' | 'completed' | 'not_found'

export interface IntakePortalData {
  state: IntakePortalState
  templateName?: string
  questions?: { id: string; label: string; type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'; options?: string[]; required: boolean }[]
  existingAnswers?: Record<string, string>
  autofill?: Record<string, string>
}

const AUTOFILL_SOURCE = {
  name: (p: typeof patients.$inferSelect) => p.nameIntakeq,
  dob: (p: typeof patients.$inferSelect) => p.dobIntakeq,
  email: (p: typeof patients.$inferSelect) => p.emailIntakeq ?? '',
  phone: (p: typeof patients.$inferSelect) => p.phoneIntakeq ?? '',
} as const

// Deliberately returns only what a specific form's own questions need --
// never diagnoses, medications, allergies, screening verdicts, or any other
// patient field. The token scopes access to exactly this one submission.
export async function getIntakePortalData(token: string): Promise<IntakePortalData> {
  const [row] = await getDb()
    .select({ submission: formSubmissions, template: formTemplates, patient: patients })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .where(eq(formSubmissions.accessToken, token))

  if (!row) return { state: 'not_found' }
  if (row.submission.status === 'completed') return { state: 'completed' }
  if (row.submission.tokenExpiresAt && row.submission.tokenExpiresAt < new Date()) return { state: 'expired' }

  const autofill: Record<string, string> = {}
  for (const q of row.template.questions) {
    if (q.autofillField) autofill[q.id] = AUTOFILL_SOURCE[q.autofillField](row.patient)
  }

  return {
    state: 'active',
    templateName: row.template.name,
    questions: row.template.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required })),
    existingAnswers: row.submission.answers ?? {},
    autofill,
  }
}

export async function getSubmissionPatientIdByToken(token: string): Promise<string | null> {
  const [row] = await getDb().select({ patientId: formSubmissions.patientId, status: formSubmissions.status, tokenExpiresAt: formSubmissions.tokenExpiresAt }).from(formSubmissions).where(eq(formSubmissions.accessToken, token))
  if (!row || row.status === 'completed' || (row.tokenExpiresAt && row.tokenExpiresAt < new Date())) return null
  return row.patientId
}
```

- [ ] **Step 2: `src/app/api/intake/[token]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getIntakePortalData, getSubmissionPatientIdByToken } from '@/lib/queries/intake-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

// Deliberately NOT requireSession()-gated -- a referred patient has no staff
// account. Authorization here is possession of the unguessable token itself,
// checked inside getIntakePortalData/getSubmissionPatientIdByToken (expired
// or completed submissions refuse access regardless of who holds the link).
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getIntakePortalData(token)
  return NextResponse.json(data)
}

const submitSchema = z.object({
  answers: z.record(z.string(), z.string()),
  complete: z.boolean(),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const patientId = await getSubmissionPatientIdByToken(token)
  if (!patientId) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  const parsed = submitSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid submission', details: parsed.error.flatten() }, { status: 400 })

  const status = parsed.data.complete ? 'completed' : 'partial'
  const completedDate = parsed.data.complete ? new Date() : null
  await getDb().update(formSubmissions).set({ answers: parsed.data.answers, status, completedDate }).where(eq(formSubmissions.accessToken, token))

  await invalidateCache(patientDetailCacheKey(patientId))
  await logPatientPortalAction(parsed.data.complete ? 'completed intake form via patient portal' : 'saved partial progress via patient portal', patientId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { GET, PUT } from '@/app/api/intake/[token]/route'

describe('GET /api/intake/[token]', () => {
  it('returns not_found for a bogus token', async () => {
    const res = await GET({} as never, { params: Promise.resolve({ token: 'nonexistent-token-xyz' }) })
    const body = await res.json()
    expect(body.state).toBe('not_found')
  })
})

describe('PUT /api/intake/[token]', () => {
  it('rejects an unknown token', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: {}, complete: false }) })
    const res = await PUT(req as never, { params: Promise.resolve({ token: 'nonexistent-token-xyz' }) })
    expect(res.status).toBe(404)
  })

  it('rejects a payload with an unexpected extra field', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: {}, complete: false, extra: 'x' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ token: 'nonexistent-token-xyz' }) })
    expect(res.status).toBe(404) // token check runs first; still confirms .strict() would reject if it got further — see brief note below
  })
})
```

Note for the implementer: write one additional test that sends a real form (via the existing `POST /api/form-submissions`, capturing the returned `accessToken`), then PUTs against that real token with an extra unexpected field, asserting a 400 — this is the test that actually exercises `.strict()` rejection, since the two tests above only exercise the not-found path. Add it following the pattern already used in `tests/api/form-submissions.test.ts` for creating a real submission in a test.

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/queries/intake-portal.ts src/app/api/intake/[token]/route.ts tests/api/intake-portal.test.ts
git commit -m "feat: add token-gated GET/PUT API for the patient intake portal"
```

---

### Task 5: The patient-facing page

**Files:**
- Create: `src/app/intake/[token]/page.tsx`
- Create: `src/components/IntakePortalForm.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `getIntakePortalData` (Task 4), `PUT /api/intake/[token]` (Task 4).

- [ ] **Step 1: `src/app/intake/[token]/page.tsx`**

A plain, standalone layout — no `LeftNav`/`TopBanner` (this is `src/app/intake/...`, outside the `(dashboard)` route group, so it does not inherit that layout at all):

```typescript
import { getIntakePortalData } from '@/lib/queries/intake-portal'
import { IntakePortalForm } from '@/components/IntakePortalForm'

export default async function IntakePortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getIntakePortalData(token)

  if (data.state === 'not_found') {
    return <PortalMessage title="Link not found" body="This link doesn't match any form on file. Please check the link or contact the office that sent it to you." />
  }
  if (data.state === 'expired') {
    return <PortalMessage title="This link has expired" body="For your security, intake links expire after 30 days. Please contact the office to request a new one." />
  }
  if (data.state === 'completed') {
    return <PortalMessage title="Already submitted" body="This form has already been completed. If you need to make a change, please contact the office directly." />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-foreground">{data.templateName}</h1>
        <p className="mb-6 text-sm text-muted-foreground">Please answer the questions below. Fields marked with an asterisk are required.</p>
        <IntakePortalForm token={token} questions={data.questions!} existingAnswers={data.existingAnswers!} autofill={data.autofill!} />
      </div>
    </div>
  )
}

function PortalMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `src/components/IntakePortalForm.tsx`**

```typescript
'use client'
import { useState } from 'react'

interface Question { id: string; label: string; type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'; options?: string[]; required: boolean }

export function IntakePortalForm({ token, questions, existingAnswers, autofill }: {
  token: string
  questions: Question[]
  existingAnswers: Record<string, string>
  autofill: Record<string, string>
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({ ...autofill, ...existingAnswers })
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }

  async function submit(complete: boolean) {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/intake/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, complete }),
    })
    setSubmitting(false)
    if (!res.ok) { setError('Something went wrong saving your answers. Please try again.'); return }
    if (complete) setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Thank you — your form has been submitted.</p>
        <p className="mt-1 text-sm text-muted-foreground">You may close this page.</p>
      </div>
    )
  }

  const requiredMissing = questions.some((q) => q.required && !answers[q.id]?.trim())

  return (
    <div className="space-y-4">
      {questions.map((q) => (
        <div key={q.id}>
          <label className="mb-1 block text-sm font-medium text-foreground">
            {q.label}{q.required && <span aria-hidden="true"> *</span>}
          </label>
          {q.type === 'textarea' ? (
            <textarea value={answers[q.id] ?? ''} onChange={(e) => update(q.id, e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={3} />
          ) : q.type === 'select' ? (
            <select value={answers[q.id] ?? ''} onChange={(e) => update(q.id, e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="">Select…</option>
              {q.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : q.type === 'checkbox' ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={answers[q.id] === 'true'} onChange={(e) => update(q.id, e.target.checked ? 'true' : 'false')} />
              I agree
            </label>
          ) : (
            <input type={q.type === 'date' ? 'date' : 'text'} value={answers[q.id] ?? ''} onChange={(e) => update(q.id, e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          )}
        </div>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-between pt-2">
        <button onClick={() => submit(false)} disabled={submitting} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50">Save and finish later</button>
        <button onClick={() => submit(true)} disabled={submitting || requiredMissing} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Submit</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Run `npm run dev` (or use the running dev server). Send a real form to a patient via the existing staff UI (`/` Home Dashboard's "Send Form to Client"), capture the `accessToken` from the database directly (`SELECT access_token FROM form_submissions ORDER BY id DESC LIMIT 1`), and visit `/intake/<that-token>` **in a private/incognito window** (to confirm it truly doesn't require the staff session cookie). Confirm: the page loads with no staff nav chrome, autofill-tagged fields are pre-populated, filling in the remaining fields and clicking Submit shows the thank-you state, and revisiting the same link afterward shows "Already submitted." Also test an expired/bogus token URL shows the correct message state.

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/app/intake src/components/IntakePortalForm.tsx
git commit -m "feat: add the patient-facing intake portal page"
```

---

### Task 6: Final QA pass

**Files:** none created; verification only.

- [ ] **Step 1: Security spot-check**

Confirm via `curl` (no cookies at all) that `GET /intake/<a-real-token>` returns 200 (not a redirect to `/login`) — proves Task 3's proxy exclusion works. Confirm `GET /api/intake/<a-real-token>`'s JSON response contains only the fields `getIntakePortalData` returns (state, templateName, questions, existingAnswers, autofill) — grep the response for `idNumberEncrypted`, any diagnosis code, any medication name, or any screening verdict string; there must be zero matches, since none of those are part of this response shape.

- [ ] **Step 2: Full-tree grep**

```bash
grep -rn "IntakeQ\|Tebra" src/app/intake src/components/IntakePortalForm.tsx src/lib/queries/intake-portal.ts src/app/api/intake
```
Must return zero matches.

- [ ] **Step 3: `npm test` and `npm run build`**

Both must be 100% clean.

- [ ] **Step 4: Confirm nothing pushed**

```bash
git status --porcelain
git log --oneline origin/master..HEAD
```
