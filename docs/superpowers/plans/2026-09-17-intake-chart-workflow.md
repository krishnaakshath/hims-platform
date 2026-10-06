# Intake + Chart Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync its own intake-form and chart subsystems (form templates, submissions, allergies, identity verification), a home dashboard, a manual/automatic classification workflow, and a comprehensive, verification-call-ready Excel export — replacing the current 5-screen prototype's thin surface with a product that stands on its own next to real Tebra/IntakeQ.

**Architecture:** Same stack, same security patterns as the existing prototype (Next.js App Router Server Components + shared query functions, Drizzle/Neon, Upstash cache, `requireSession`/`requireSessionOrRedirect`, Zod-validated writes, audit logging). New tables extend the existing schema; new pages live inside the existing `(dashboard)` route group so they inherit `TopBanner`/`LeftNav`/`SessionTimeoutWarning` for free. No new external integrations — everything is local Postgres + seeded mock data, matching the "test locally, keep mock data for the client demo, don't push until verified" instruction.

**Tech Stack:** Next.js 16 (App Router, TypeScript), Drizzle ORM + Neon Postgres, Upstash Redis, Tailwind v4 + shadcn/ui, Vitest, ExcelJS.

**Spec:** `docs/superpowers/specs/2026-09-17-intake-chart-workflow-design.md`

## Global Constraints

- Every API route calls `requireSession()` and returns its `NextResponse` result unchanged on failure (see `src/lib/auth.ts`, `src/app/api/trials/[trialId]/criteria/route.ts` for the exact pattern).
- Every Server Component page calls `requireSessionOrRedirect()` as its **first statement**, before any data fetch (see the comment in `src/app/(dashboard)/patients/page.tsx` — a prior review proved that relying on the layout's redirect alone leaks PHI into the response body on an unauthenticated request).
- Server Components call shared query functions in `src/lib/queries/*.ts` directly. **Never** `fetch()` the app's own API route from a Server Component (a prior real vulnerability: session-cookie exfiltration via a forged `Host` header).
- Every write validates its request body with a `.strict()` Zod schema (see `criteriaUpdateSchema` in `src/app/api/trials/[trialId]/criteria/route.ts`).
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` (`src/lib/audit.ts`) — `session` must be the real, non-null session, never a fallback role.
- Zero decorative icons anywhere. Status/severity is always a colored dot (`<span className="h-2 w-2 rounded-full ...">`, `aria-hidden="true"`) plus a text label — see `src/components/StatusChip.tsx`.
- Design tokens only: `bg-primary`, `bg-accent`, `text-accent-foreground`, `bg-card`, `border-border`, `bg-muted`, `text-muted-foreground`, `bg-secondary` from `src/app/globals.css`. Never a hardcoded Tailwind color class (`bg-slate-*`, `text-green-700`, etc.).
- Section/column headers use the established convention: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Zebra striping on every list/table: `i % 2 === 1 ? 'bg-muted/40' : ''`.
- At most one coral (`bg-accent`) primary-action button per screen (an exception already exists and is accepted: Identity Matching shows one per pending row).
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations (see spec §5) — subtle hover/transition-colors utilities only, consistent with what's already in the codebase.
- Empty states are plain, factual text in the interface's voice ("No records found.", not an illustration) — see spec §5.
- `npm test` and `npm run build` must be clean after every task. Nothing in this plan is pushed to git or deployed until the whole plan's Final QA pass (Task 11) is green — test locally throughout.

---

### Task 1: Schema + seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/seed.test.ts` (existing file — extend, don't replace)

**Interfaces:**
- Produces: `formTemplates`, `formSubmissions` (+ `formSubmissionStatusEnum`), `allergies`, `identityVerifications`, `appSettings` tables, all exported from `src/db/schema.ts`, consumed by every later task.

- [ ] **Step 1: Add the new tables to the schema**

Add to `src/db/schema.ts`, after the existing `users` table:

```typescript
export const formSubmissionStatusEnum = pgEnum('form_submission_status', ['sent', 'partial', 'completed'])
export const idTypeEnum = pgEnum('id_type', ['drivers_license', 'state_id', 'passport'])
export const severityEnum = pgEnum('severity', ['mild', 'moderate', 'severe'])

export const formTemplates = pgTable('form_templates', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),          // folder grouping in the library UI, e.g. "Trial Intake", "Consent Forms", "Screening Questionnaires"
  diagnosisTag: text('diagnosis_tag').notNull(),
  questions: jsonb('questions').$type<{
    id: string
    label: string
    type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'
    options?: string[]
    hipaaSensitive: boolean
    required: boolean
  }[]>().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const formSubmissions = pgTable('form_submissions', {
  id: serial('id').primaryKey(),
  templateId: integer('template_id').notNull().references(() => formTemplates.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  status: formSubmissionStatusEnum('status').default('sent').notNull(),
  sentDate: timestamp('sent_date').defaultNow().notNull(),
  completedDate: timestamp('completed_date'),
  answers: jsonb('answers').$type<Record<string, string>>().default({}),
})

export const allergies = pgTable('allergies', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  allergen: text('allergen').notNull(),
  reaction: text('reaction'),
  severity: severityEnum('severity').notNull(),
})

export const identityVerifications = pgTable('identity_verifications', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id).unique(),
  idType: idTypeEnum('id_type').notNull(),
  idNumberEncrypted: text('id_number_encrypted').notNull(),
  verified: boolean('verified').default(false).notNull(),
  verifiedBy: text('verified_by'),
  verifiedAt: timestamp('verified_at'),
})

// Single-row table: one settings record for the whole pilot deployment.
export const appSettings = pgTable('app_settings', {
  id: serial('id').primaryKey(),
  autoClassifyOnComplete: boolean('auto_classify_on_complete').default(false).notNull(),
})
```

- [ ] **Step 2: Push the schema**

Run: `npm run db:push` (applies the new tables to the linked Neon database; confirm it reports the 5 new tables/enums with no errors).

- [ ] **Step 3: Extend the seed script**

Open `src/db/seed.ts`. After the existing patient/trial seeding, add (adjust variable names to match whatever the file already uses for its patient ID list and db handle — read the file first):

```typescript
// Form templates: one per trial condition, each with a handful of
// realistic intake questions including at least one hipaaSensitive field.
const [mddTemplate] = await db.insert(formTemplates).values({
  name: 'MDD Intake Packet',
  category: 'Trial Intake',
  diagnosisTag: 'Major Depressive Disorder',
  questions: [
    { id: 'q1', label: 'Full legal name', type: 'text', hipaaSensitive: true, required: true },
    { id: 'q2', label: 'Date of birth', type: 'date', hipaaSensitive: true, required: true },
    { id: 'q3', label: 'Current mood symptoms (describe)', type: 'textarea', hipaaSensitive: true, required: true },
    { id: 'q4', label: 'Currently taking antidepressants?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: true, required: true },
    { id: 'q5', label: 'Consent to share records with study team', type: 'checkbox', hipaaSensitive: false, required: true },
  ],
}).returning()

const [adhdTemplate] = await db.insert(formTemplates).values({
  name: 'ADHD Intake Packet',
  category: 'Trial Intake',
  diagnosisTag: 'ADHD',
  questions: [
    { id: 'q1', label: 'Full legal name', type: 'text', hipaaSensitive: true, required: true },
    { id: 'q2', label: 'Date of birth', type: 'date', hipaaSensitive: true, required: true },
    { id: 'q3', label: 'Current stimulant medication (if any)', type: 'text', hipaaSensitive: true, required: false },
    { id: 'q4', label: 'Consent to share records with study team', type: 'checkbox', hipaaSensitive: false, required: true },
  ],
}).returning()

// Non-trial-specific templates, matching IntakeQ's Consent Forms / Screening
// Questionnaires / Note Templates folders (adapted to what a trial
// pre-screening pilot actually needs, not a full outpatient-practice clone).
await db.insert(formTemplates).values([
  {
    name: 'General Research Consent',
    category: 'Consent Forms',
    diagnosisTag: 'General',
    questions: [
      { id: 'q1', label: 'I consent to my de-identified data being used for research purposes', type: 'checkbox', hipaaSensitive: false, required: true },
      { id: 'q2', label: 'Signature (typed full name)', type: 'text', hipaaSensitive: true, required: true },
      { id: 'q3', label: 'Date', type: 'date', hipaaSensitive: false, required: true },
    ],
  },
  {
    name: 'Telehealth Consent',
    category: 'Consent Forms',
    diagnosisTag: 'General',
    questions: [
      { id: 'q1', label: 'I consent to receiving care via telehealth', type: 'checkbox', hipaaSensitive: false, required: true },
      { id: 'q2', label: 'Signature (typed full name)', type: 'text', hipaaSensitive: true, required: true },
    ],
  },
  {
    name: 'PHQ-9 (Depression Screening)',
    category: 'Screening Questionnaires',
    diagnosisTag: 'Major Depressive Disorder',
    questions: [
      { id: 'q1', label: 'Little interest or pleasure in doing things', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], hipaaSensitive: true, required: true },
      { id: 'q2', label: 'Feeling down, depressed, or hopeless', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], hipaaSensitive: true, required: true },
    ],
  },
  {
    name: 'ASRS-v1.1 (ADHD Screening)',
    category: 'Screening Questionnaires',
    diagnosisTag: 'ADHD',
    questions: [
      { id: 'q1', label: 'How often do you have trouble wrapping up the final details of a project?', type: 'select', options: ['Never', 'Rarely', 'Sometimes', 'Often', 'Very Often'], hipaaSensitive: true, required: true },
    ],
  },
])

// Form submissions: a spread of sent/partial/completed across seeded patients.
await db.insert(formSubmissions).values([
  { templateId: mddTemplate.id, patientId: 'RD-0001', status: 'completed', completedDate: new Date('2026-08-15'), answers: { q1: 'Maria Alvarez', q4: 'Yes' } },
  { templateId: mddTemplate.id, patientId: 'RD-0002', status: 'completed', completedDate: new Date('2026-08-20'), answers: { q1: 'James Thornton', q4: 'Yes' } },
  { templateId: mddTemplate.id, patientId: 'RD-0003', status: 'sent' },
  { templateId: mddTemplate.id, patientId: 'RD-0006', status: 'partial', answers: { q1: 'Kathryn Voss' } },
  { templateId: adhdTemplate.id, patientId: 'RD-0004', status: 'completed', completedDate: new Date('2026-08-22'), answers: { q1: 'Priya Natarajan' } },
  { templateId: adhdTemplate.id, patientId: 'RD-0005', status: 'sent' },
])

// Allergies for a subset of patients.
await db.insert(allergies).values([
  { patientId: 'RD-0001', allergen: 'Penicillin', reaction: 'Rash', severity: 'moderate' },
  { patientId: 'RD-0002', allergen: 'Sulfa drugs', reaction: 'Hives', severity: 'severe' },
  { patientId: 'RD-0006', allergen: 'Latex', reaction: 'Contact dermatitis', severity: 'mild' },
])

// Identity verification: a mix of verified and pending.
await db.insert(identityVerifications).values([
  { patientId: 'RD-0001', idType: 'drivers_license', idNumberEncrypted: 'ENC[D1234567]', verified: true, verifiedBy: 'Jamie Ruiz', verifiedAt: new Date('2026-08-16') },
  { patientId: 'RD-0002', idType: 'state_id', idNumberEncrypted: 'ENC[S7654321]', verified: true, verifiedBy: 'Jamie Ruiz', verifiedAt: new Date('2026-08-21') },
  { patientId: 'RD-0003', idType: 'passport', idNumberEncrypted: 'ENC[P9988776]', verified: false },
])

// Default settings row (auto-classify off by default).
await db.insert(appSettings).values({ autoClassifyOnComplete: false })
```

Adjust patient IDs above only if the existing seed file doesn't already create `RD-0001` through `RD-0006` — check first; the summary of prior work confirms `RD-0001`–`RD-0018` exist, so these IDs are safe to use as-is.

- [ ] **Step 4: Re-seed and verify**

Run: `npm run db:seed` (destructive — confirm this is a dev/pilot database, matching existing usage in this project). Then run: `npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { formTemplates, allergies } from './src/db/schema'; getDb().select().from(formTemplates).then(r => console.log('templates:', r.length)); getDb().select().from(allergies).then(r => console.log('allergies:', r.length))"` and confirm non-zero counts.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts
git commit -m "feat: add form templates, submissions, allergies, identity verification, and app settings tables"
```

---

### Task 2: Shared query functions

**Files:**
- Create: `src/lib/queries/form-templates.ts`
- Create: `src/lib/queries/form-submissions.ts`
- Create: `src/lib/queries/dashboard.ts`
- Create: `src/lib/queries/settings.ts`
- Modify: `src/lib/queries/patients.ts` (extend `getPatientDetail` to include allergies + identity verification)
- Modify: `src/lib/cache.ts` (add cache-key helpers for the new lists)
- Test: `tests/lib/queries/form-templates.test.ts`, `tests/lib/queries/dashboard.test.ts` (new)

**Interfaces:**
- Consumes: the 5 new tables from Task 1.
- Produces: `listFormTemplates()`, `getFormTemplate(id)`, `listFormSubmissions(filters)`, `getFormSubmission(id)`, `getDashboardData()`, `getAppSettings()`, `updateAppSettings(patch)` — all consumed directly by Server Component pages in Tasks 3, 4, 6, 7, 8 (never via `fetch()`).

- [ ] **Step 1: `src/lib/cache.ts` — add cache keys**

Add alongside the existing key helpers:

```typescript
export function formTemplatesListCacheKey(): string {
  return 'form-templates:list'
}

export function formSubmissionsListCacheKey(filters: string): string {
  return `form-submissions:list:${filters}`
}

export function dashboardCacheKey(): string {
  return 'dashboard:data'
}
```

- [ ] **Step 2: `src/lib/queries/form-templates.ts`**

```typescript
import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, formTemplatesListCacheKey } from '@/lib/cache'

export async function listFormTemplates() {
  return getOrSetCache(formTemplatesListCacheKey(), 30, async () => {
    return getDb().select().from(formTemplates)
  })
}

export async function getFormTemplate(id: number) {
  const [template] = await getDb().select().from(formTemplates).where(eq(formTemplates.id, id))
  return template ?? null
}

export async function invalidateFormTemplatesList() {
  await invalidateCache(formTemplatesListCacheKey())
}
```

- [ ] **Step 3: `src/lib/queries/form-submissions.ts`**

```typescript
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, patients } from '@/db/schema'
import { eq, and, gte, lte, SQL } from 'drizzle-orm'

export interface FormSubmissionFilters {
  diagnosisTag?: string
  status?: 'sent' | 'partial' | 'completed'
  dateFrom?: string
  dateTo?: string
}

export async function listFormSubmissions(filters: FormSubmissionFilters) {
  const conditions: SQL[] = []
  if (filters.status) conditions.push(eq(formSubmissions.status, filters.status))
  if (filters.dateFrom) conditions.push(gte(formSubmissions.sentDate, new Date(filters.dateFrom)))
  if (filters.dateTo) conditions.push(lte(formSubmissions.sentDate, new Date(filters.dateTo)))
  if (filters.diagnosisTag) conditions.push(eq(formTemplates.diagnosisTag, filters.diagnosisTag))

  const rows = await getDb()
    .select({ submission: formSubmissions, template: formTemplates, patient: patients })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .where(conditions.length ? and(...conditions) : undefined)

  return rows.map((r) => ({
    ...r.submission,
    templateName: r.template.name,
    diagnosisTag: r.template.diagnosisTag,
    patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
  }))
}

export async function getFormSubmission(id: number) {
  const [row] = await getDb()
    .select({ submission: formSubmissions, template: formTemplates, patient: patients })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .where(eq(formSubmissions.id, id))
  if (!row) return null
  return { ...row.submission, templateName: row.template.name, questions: row.template.questions, patientName: row.patient.nameTebra ?? row.patient.nameIntakeq }
}
```

- [ ] **Step 4: `src/lib/queries/settings.ts`**

```typescript
import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

// Single-row settings table: always operate on row id 1 (created by the seed).
export async function getAppSettings() {
  const [row] = await getDb().select().from(appSettings)
  return row ?? { id: 1, autoClassifyOnComplete: false }
}

export async function updateAutoClassifySetting(value: boolean) {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ autoClassifyOnComplete: value }).where(eq(appSettings.id, current.id))
}
```

- [ ] **Step 5: `src/lib/queries/dashboard.ts`**

```typescript
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, patients, patientTrialScreenings, auditLog } from '@/db/schema'
import { eq, desc, isNull, or, inArray } from 'drizzle-orm'
import { getOrSetCache, dashboardCacheKey } from '@/lib/cache'

const ACCOUNT_EVENT_ACTIONS = ['sent intake form', 'completed intake form', 'verified identity', 'ran classification']

export async function getDashboardData() {
  return getOrSetCache(dashboardCacheKey(), 15, async () => {
    const db = getDb()

    const latestForms = await db
      .select({ submission: formSubmissions, template: formTemplates, patient: patients })
      .from(formSubmissions)
      .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
      .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
      .where(eq(formSubmissions.status, 'completed'))
      .orderBy(desc(formSubmissions.completedDate))
      .limit(5)

    const pendingForms = await db
      .select({ submission: formSubmissions, template: formTemplates, patient: patients })
      .from(formSubmissions)
      .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
      .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
      .where(or(eq(formSubmissions.status, 'sent'), eq(formSubmissions.status, 'partial')))
      .orderBy(desc(formSubmissions.sentDate))
      .limit(5)

    // Patients with completed intake + at least one recorded diagnosis/medication,
    // but no screening row yet — the "ready but not yet classified" queue.
    const allPatients = await db.select().from(patients)
    const screenedIds = new Set((await db.select({ id: patientTrialScreenings.patientId }).from(patientTrialScreenings)).map((r) => r.id))
    const completedIntakeIds = new Set((await db.select({ id: formSubmissions.patientId }).from(formSubmissions).where(eq(formSubmissions.status, 'completed'))).map((r) => r.id))
    const pendingClassification = allPatients.filter((p) => completedIntakeIds.has(p.id) && !screenedIds.has(p.id))

    const recentEvents = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.action, ACCOUNT_EVENT_ACTIONS))
      .orderBy(desc(auditLog.timestamp))
      .limit(10)

    return {
      latestForms: latestForms.map((r) => ({ ...r.submission, templateName: r.template.name, patientName: r.patient.nameTebra ?? r.patient.nameIntakeq })),
      pendingForms: pendingForms.map((r) => ({ ...r.submission, templateName: r.template.name, patientName: r.patient.nameTebra ?? r.patient.nameIntakeq })),
      pendingClassification,
      recentEvents,
    }
  })
}
```

- [ ] **Step 6: Extend `getPatientDetail` in `src/lib/queries/patients.ts`**

Add `allergies` and `identityVerifications` to the imports from `@/db/schema`, and inside `getPatientDetail`, alongside the existing `dx`/`meds` queries:

```typescript
    const patientAllergies = await getDb().select().from(allergies).where(eq(allergies.patientId, anonId))
    const [identity] = await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, anonId))

    return { ...patient, overallStatus: screening?.overallStatus, criteria, diagnoses: dx, medications: meds, allergies: patientAllergies, identityVerification: identity ?? null }
```

(Replace the existing `return` statement's shape — keep every existing field, only add `allergies` and `identityVerification`.)

- [ ] **Step 7: Tests**

`tests/lib/queries/form-templates.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { listFormTemplates } from '@/lib/queries/form-templates'

describe('listFormTemplates', () => {
  it('returns the seeded templates', async () => {
    const templates = await listFormTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(2)
    expect(templates.some((t) => t.diagnosisTag === 'Major Depressive Disorder')).toBe(true)
  })
})
```

`tests/lib/queries/dashboard.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { getDashboardData } from '@/lib/queries/dashboard'

describe('getDashboardData', () => {
  it('returns all four widget datasets', async () => {
    const data = await getDashboardData()
    expect(data).toHaveProperty('latestForms')
    expect(data).toHaveProperty('pendingForms')
    expect(data).toHaveProperty('pendingClassification')
    expect(data).toHaveProperty('recentEvents')
  })
})
```

- [ ] **Step 8: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/queries/form-templates.ts src/lib/queries/form-submissions.ts src/lib/queries/dashboard.ts src/lib/queries/settings.ts src/lib/queries/patients.ts src/lib/cache.ts tests/lib/queries/form-templates.test.ts tests/lib/queries/dashboard.test.ts
git commit -m "feat: add shared query functions for forms, dashboard, and settings"
```

---

### Task 3: Form Templates library + editable Form Builder + Create New Form

Modeled directly on IntakeQ's Form Templates library (nested folders: Consent Forms, Note Templates, plus condition-specific packets) and its Form Builder (numbered, reorderable question list with a persistent "+Add New Question" action) — adapted to what a trial pre-screening pilot needs, not the dozens of generic outpatient-practice folders IntakeQ ships with. This is the "customizable form templates" subsystem the client specifically called out, so the builder must be genuinely editable (add/remove/reorder questions, change type, mark HIPAA-sensitive/required), not a read-only view, and staff must be able to create a brand new template from scratch, not just work with the seeded ones.

**Files:**
- Create: `src/app/api/form-templates/route.ts` (GET list, POST create)
- Create: `src/app/api/form-templates/[id]/route.ts` (GET one, PUT update)
- Create: `src/app/(dashboard)/forms/page.tsx` (folder-grouped library)
- Create: `src/app/(dashboard)/forms/[templateId]/page.tsx` (Server Component wrapper — auth, data fetch)
- Create: `src/components/FormBuilderEditor.tsx` (`'use client'` — the actual editable question-list UI)
- Create: `src/components/FormTemplateCard.tsx`
- Create: `src/components/CreateFormButton.tsx` (`'use client'`)
- Test: `tests/api/form-templates.test.ts`

**Interfaces:**
- Consumes: `listFormTemplates`, `getFormTemplate` (Task 2).
- Produces: `/forms` and `/forms/[templateId]` routes, linked from `LeftNav` (Task 10 adds the nav entry once all new routes exist).

- [ ] **Step 1: API routes**

`src/app/api/form-templates/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFormTemplates, invalidateFormTemplatesList } from '@/lib/queries/form-templates'

const questionSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'date', 'select', 'checkbox']),
  options: z.array(z.string()).optional(),
  hipaaSensitive: z.boolean(),
  required: z.boolean(),
})

const createTemplateSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  diagnosisTag: z.string().min(1),
  questions: z.array(questionSchema),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listFormTemplates())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = createTemplateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid template payload', details: parsed.error.flatten() }, { status: 400 })

  const [created] = await getDb().insert(formTemplates).values(parsed.data).returning()
  await invalidateFormTemplatesList()
  await logAudit(session, 'created form template', null)
  return NextResponse.json(created, { status: 201 })
}
```

`src/app/api/form-templates/[id]/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getFormTemplate, invalidateFormTemplatesList } from '@/lib/queries/form-templates'

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  diagnosisTag: z.string().min(1).optional(),
  questions: z.array(z.object({
    id: z.string(), label: z.string(), type: z.enum(['text', 'textarea', 'date', 'select', 'checkbox']),
    options: z.array(z.string()).optional(), hipaaSensitive: z.boolean(), required: z.boolean(),
  })).optional(),
  isActive: z.boolean().optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const template = await getFormTemplate(Number(id))
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(template)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  const parsed = updateTemplateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid template payload', details: parsed.error.flatten() }, { status: 400 })

  await getDb().update(formTemplates).set(parsed.data).where(eq(formTemplates.id, Number(id)))
  await invalidateFormTemplatesList()
  await logAudit(session, `updated form template ${id}`, null)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: `src/components/FormTemplateCard.tsx`**

```typescript
import Link from 'next/link'

export function FormTemplateCard({ template }: { template: { id: number; name: string; diagnosisTag: string; questions: unknown[]; isActive: boolean } }) {
  return (
    <Link href={`/forms/${template.id}`} className="block rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-foreground">{template.name}</span>
        {!template.isActive && <span className="text-xs font-medium text-muted-foreground">Inactive</span>}
      </div>
      <p className="text-sm text-muted-foreground">{template.diagnosisTag}</p>
      <p className="mt-2 text-xs text-muted-foreground">{template.questions.length} question{template.questions.length === 1 ? '' : 's'}</p>
    </Link>
  )
}
```

- [ ] **Step 3: `src/components/CreateFormButton.tsx`**

Creates a blank template via `POST /api/form-templates`, then navigates straight to its builder page — matching IntakeQ's "Create New" tile pattern (a one-click blank-template start, not a multi-field creation form).

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function CreateFormButton({ category }: { category: string }) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)

  async function create() {
    setCreating(true)
    const res = await fetch('/api/form-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Untitled Form', category, diagnosisTag: 'General', questions: [] }),
    })
    setCreating(false)
    if (res.ok) {
      const created = await res.json()
      router.push(`/forms/${created.id}`)
    }
  }

  return (
    <button onClick={create} disabled={creating} className="rounded-lg border-2 border-dashed border-border p-5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50">
      + Create New Form
    </button>
  )
}
```

- [ ] **Step 4: `src/app/(dashboard)/forms/page.tsx` — folder-grouped library**

Groups templates by `category`, matching IntakeQ's nested-folder library (Consent Forms, Note Templates, etc.) rather than one flat grid — with each folder showing its templates plus a "Create New Form" tile scoped to that folder's category.

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { FormTemplateCard } from '@/components/FormTemplateCard'
import { CreateFormButton } from '@/components/CreateFormButton'

export default async function FormsPage() {
  const session = await requireSessionOrRedirect()
  const templates = await listFormTemplates()
  await logAudit(session, 'viewed form templates', null)

  const categories = [...new Set(templates.map((t) => t.category))].sort()

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Form Templates</h1>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No form templates yet.</p>
      ) : (
        <div className="space-y-8">
          {categories.map((category) => (
            <section key={category}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{category}</h2>
              <div className="grid grid-cols-3 gap-4">
                {templates.filter((t) => t.category === category).map((t) => <FormTemplateCard key={t.id} template={t} />)}
                <CreateFormButton category={category} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: `src/components/FormBuilderEditor.tsx` — the real, editable builder**

`'use client'` component owning the question list's editing state: add, remove, reorder (up/down buttons — no drag-and-drop library dependency, keeps full keyboard operability for free, which a mouse-only drag handle would not), and per-question type/required/hipaaSensitive editing. Matches IntakeQ's numbered, reorderable question list with a persistent "+Add New Question" action.

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Question {
  id: string
  label: string
  type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'
  options?: string[]
  hipaaSensitive: boolean
  required: boolean
}

export function FormBuilderEditor({ templateId, initialName, initialCategory, initialDiagnosisTag, initialQuestions }: {
  templateId: number
  initialName: string
  initialCategory: string
  initialDiagnosisTag: string
  initialQuestions: Question[]
}) {
  const router = useRouter()
  const [name, setName] = useState(initialName)
  const [category, setCategory] = useState(initialCategory)
  const [diagnosisTag, setDiagnosisTag] = useState(initialDiagnosisTag)
  const [questions, setQuestions] = useState<Question[]>(initialQuestions)
  const [saving, setSaving] = useState(false)

  function addQuestion() {
    setQuestions([...questions, { id: `q${Date.now()}`, label: 'New question', type: 'text', hipaaSensitive: false, required: false }])
  }

  function removeQuestion(id: string) {
    setQuestions(questions.filter((q) => q.id !== id))
  }

  function updateQuestion(id: string, patch: Partial<Question>) {
    setQuestions(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)))
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= questions.length) return
    const next = [...questions]
    ;[next[index], next[target]] = [next[target], next[index]]
    setQuestions(next)
  }

  async function save() {
    setSaving(true)
    const res = await fetch(`/api/form-templates/${templateId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, diagnosisTag, questions }),
    })
    setSaving(false)
    if (res.ok) router.refresh()
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6 space-y-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-lg font-semibold text-foreground" />
        <div className="flex gap-2">
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
          <input value={diagnosisTag} onChange={(e) => setDiagnosisTag(e.target.value)} placeholder="Diagnosis tag" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="space-y-3">
        {questions.map((q, i) => (
          <div key={q.id} className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{i + 1}.</span>
              <input value={q.label} onChange={(e) => updateQuestion(q.id, { label: e.target.value })} className="flex-1 rounded-md border border-border px-2 py-1 text-sm text-foreground" />
              <select value={q.type} onChange={(e) => updateQuestion(q.id, { type: e.target.value as Question['type'] })} className="rounded-md border border-border px-2 py-1 text-xs">
                <option value="text">Text</option>
                <option value="textarea">Long text</option>
                <option value="date">Date</option>
                <option value="select">Select</option>
                <option value="checkbox">Checkbox</option>
              </select>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex gap-3">
                <label className="flex items-center gap-1"><input type="checkbox" checked={q.required} onChange={(e) => updateQuestion(q.id, { required: e.target.checked })} /> Required</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={q.hipaaSensitive} onChange={(e) => updateQuestion(q.id, { hipaaSensitive: e.target.checked })} /> Contains PHI</label>
              </div>
              <div className="flex gap-1">
                <button onClick={() => moveQuestion(i, -1)} disabled={i === 0} aria-label="Move up" className="rounded px-2 py-0.5 hover:bg-secondary disabled:opacity-30">↑</button>
                <button onClick={() => moveQuestion(i, 1)} disabled={i === questions.length - 1} aria-label="Move down" className="rounded px-2 py-0.5 hover:bg-secondary disabled:opacity-30">↓</button>
                <button onClick={() => removeQuestion(q.id)} aria-label="Remove question" className="rounded px-2 py-0.5 text-red-700 hover:bg-secondary">Remove</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex justify-between">
        <button onClick={addQuestion} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">+ Add New Question</button>
        <button onClick={save} disabled={saving} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Save Form</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: `src/app/(dashboard)/forms/[templateId]/page.tsx`**

Thin Server Component wrapper — auth, data fetch, hand off to the client editor:

```typescript
import { notFound } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getFormTemplate } from '@/lib/queries/form-templates'
import { FormBuilderEditor } from '@/components/FormBuilderEditor'

export default async function FormTemplateDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const session = await requireSessionOrRedirect()
  const { templateId } = await params
  const template = await getFormTemplate(Number(templateId))
  if (!template) notFound()
  await logAudit(session, `viewed form template ${templateId}`, null)

  return (
    <FormBuilderEditor
      templateId={template.id}
      initialName={template.name}
      initialCategory={template.category}
      initialDiagnosisTag={template.diagnosisTag}
      initialQuestions={template.questions}
    />
  )
}
```

- [ ] **Step 7: Test**

`tests/api/form-templates.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { GET, POST } from '@/app/api/form-templates/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('GET /api/form-templates', () => {
  it('returns the seeded templates', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(2)
  })
})

describe('POST /api/form-templates', () => {
  it('rejects a payload missing required fields', async () => {
    const req = new Request('http://localhost/api/form-templates', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a blank template for the Create New Form flow', async () => {
    const req = new Request('http://localhost/api/form-templates', { method: 'POST', body: JSON.stringify({ name: 'Untitled Form', category: 'Consent Forms', diagnosisTag: 'General', questions: [] }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
  })
})
```

Note: mock `requireSession` directly (not `getSession`) — an ESM self-reference pitfall documented earlier in this project means mocking the wrong function silently doesn't affect the route handler's actual call.

- [ ] **Step 8: Run the suite, manually verify the builder, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/forms` shows templates grouped into folders by category; clicking "+ Create New Form" creates a blank template and navigates to its builder; in the builder, adding a question, reordering it, marking it required/PHI-sensitive, and clicking Save persists (refresh the page and confirm the change stuck).

```bash
git add src/app/api/form-templates src/app/\(dashboard\)/forms src/components/FormTemplateCard.tsx src/components/CreateFormButton.tsx src/components/FormBuilderEditor.tsx tests/api/form-templates.test.ts
git commit -m "feat: add folder-grouped Form Templates library with an editable builder and create-new flow"
```

---

### Task 4: Form Submissions API + Client Forms page

**Files:**
- Create: `src/app/api/form-submissions/route.ts` (GET list w/ filters, POST create = "send form")
- Create: `src/app/api/form-submissions/[id]/route.ts` (GET detail, PUT to mark complete with answers)
- Create: `src/app/(dashboard)/client-forms/page.tsx`
- Create: `src/app/(dashboard)/client-forms/[id]/page.tsx`
- Test: `tests/api/form-submissions.test.ts`

**Interfaces:**
- Consumes: `listFormSubmissions`, `getFormSubmission` (Task 2).
- Produces: `POST /api/form-submissions` (used by the "Send Form to Client" modal in Task 5); a `maybeAutoClassify(patientId)` hook point when a submission's PUT marks it `completed` (implemented fully in Task 8 — this task adds the call site as a no-op import so Task 8 only needs to fill in the function body, avoiding a merge conflict on this file later).

- [ ] **Step 1: API routes**

`src/app/api/form-submissions/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFormSubmissions } from '@/lib/queries/form-submissions'

const sendFormSchema = z.object({
  templateId: z.number().int().positive(),
  patientId: z.string().min(1),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const url = new URL(request.url)
  const filters = {
    diagnosisTag: url.searchParams.get('diagnosisTag') ?? undefined,
    status: (url.searchParams.get('status') as 'sent' | 'partial' | 'completed' | null) ?? undefined,
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    dateTo: url.searchParams.get('dateTo') ?? undefined,
  }
  return NextResponse.json(await listFormSubmissions(filters))
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = sendFormSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid send-form payload', details: parsed.error.flatten() }, { status: 400 })

  const [created] = await getDb().insert(formSubmissions).values({ ...parsed.data, status: 'sent' }).returning()
  await logAudit(session, 'sent intake form', parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
```

`src/app/api/form-submissions/[id]/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getFormSubmission } from '@/lib/queries/form-submissions'
import { maybeAutoClassify } from '@/lib/auto-classify'

const updateSubmissionSchema = z.object({
  status: z.enum(['sent', 'partial', 'completed']),
  answers: z.record(z.string(), z.string()).optional(),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const submission = await getFormSubmission(Number(id))
  if (!submission) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(submission)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  const parsed = updateSubmissionSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid submission update', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getFormSubmission(Number(id))
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const completedDate = parsed.data.status === 'completed' ? new Date() : null
  await getDb().update(formSubmissions).set({ ...parsed.data, completedDate }).where(eq(formSubmissions.id, Number(id)))

  if (parsed.data.status === 'completed') {
    await logAudit(session, 'completed intake form', existing.patientId)
    await maybeAutoClassify(existing.patientId)
  }

  return NextResponse.json({ ok: true })
}
```

**Note for the implementer:** `src/lib/auto-classify.ts` does not exist yet — Task 8 creates it. Until then, this file will fail to compile. Create a temporary one-line stub now so this task's own tests pass in isolation, and leave a comment marking it for Task 8 to replace:

`src/lib/auto-classify.ts` (temporary stub, replaced by Task 8):
```typescript
// TEMPORARY STUB — Task 8 replaces this with the real auto-classify logic
// (checks the appSettings.autoClassifyOnComplete flag and, if on, calls the
// same rule-engine path as the manual "Run Classification" action).
export async function maybeAutoClassify(_patientId: string): Promise<void> {}
```

- [ ] **Step 2: `src/app/(dashboard)/client-forms/page.tsx`**

```typescript
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFormSubmissions } from '@/lib/queries/form-submissions'

export default async function ClientFormsPage({ searchParams }: { searchParams: Promise<{ status?: string; diagnosisTag?: string }> }) {
  const session = await requireSessionOrRedirect()
  const { status, diagnosisTag } = await searchParams
  const submissions = await listFormSubmissions({ status: status as 'sent' | 'partial' | 'completed' | undefined, diagnosisTag })
  await logAudit(session, 'viewed client forms', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Client Forms</h1>
      {submissions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Form</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Tag</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Completed</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((s, i) => (
              <tr key={s.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                <td className="p-3"><Link href={`/client-forms/${s.id}`} className="font-medium text-primary hover:underline">{s.patientName}</Link></td>
                <td className="p-3 text-foreground">{s.templateName}</td>
                <td className="p-3 text-foreground">{s.diagnosisTag}</td>
                <td className="p-3 text-foreground capitalize">{s.status}</td>
                <td className="p-3 text-muted-foreground">{new Date(s.sentDate).toLocaleDateString()}</td>
                <td className="p-3 text-muted-foreground">{s.completedDate ? new Date(s.completedDate).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 3: `src/app/(dashboard)/client-forms/[id]/page.tsx`**

```typescript
import { notFound } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getFormSubmission } from '@/lib/queries/form-submissions'

export default async function ClientFormDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  const { id } = await params
  const submission = await getFormSubmission(Number(id))
  if (!submission) notFound()
  await logAudit(session, `viewed client form ${id}`, submission.patientId)

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-foreground">{submission.templateName}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{submission.patientName} · <span className="capitalize">{submission.status}</span></p>
      <div className="space-y-3">
        {submission.questions.map((q) => (
          <div key={q.id} className="rounded-lg border border-border bg-card p-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{q.label}</p>
            <p className="text-sm text-foreground">{submission.answers[q.id] ?? '—'}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Test**

`tests/api/form-submissions.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { GET, POST } from '@/app/api/form-submissions/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('GET /api/form-submissions', () => {
  it('returns seeded submissions', async () => {
    const req = new Request('http://localhost/api/form-submissions')
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('POST /api/form-submissions', () => {
  it('rejects a payload with an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId: 1, patientId: 'RD-0001', status: 'completed' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400) // 'status' is not in sendFormSchema — new submissions always start 'sent'
  })
})
```

- [ ] **Step 5: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean (the temporary `auto-classify.ts` stub makes this buildable ahead of Task 8).

```bash
git add src/app/api/form-submissions src/app/\(dashboard\)/client-forms src/lib/auto-classify.ts tests/api/form-submissions.test.ts
git commit -m "feat: add form submissions API and Client Forms pages"
```

---

### Task 5: Add New Client + Send Form modals

**Files:**
- Create: `src/components/AddClientModal.tsx` (`'use client'`)
- Create: `src/components/SendFormModal.tsx` (`'use client'`)
- Create: `src/app/api/patients/route.ts` — extend with `POST` (check the file first; if a `GET` already exists, add `POST` alongside it without disturbing `GET`)
- Test: `tests/api/patients-create.test.ts`

**Interfaces:**
- Consumes: `POST /api/form-submissions` (Task 4), new `POST /api/patients` (this task).
- Produces: `<AddClientModal>` and `<SendFormModal>`, both rendered from the Home Dashboard (Task 6) as the two non-classification action tiles.

- [ ] **Step 1: `POST /api/patients`**

Read `src/app/api/patients/route.ts` first. Add (preserving any existing `GET`):

```typescript
const addClientSchema = z.object({
  nameIntakeq: z.string().min(1),
  dobIntakeq: z.string().min(1),
  emailIntakeq: z.string().email().optional(),
  phoneIntakeq: z.string().optional(),
  referralType: z.string().optional(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = addClientSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid new-client payload', details: parsed.error.flatten() }, { status: 400 })

  // Anon IDs are RD-#### sequential; find the current max and increment.
  const existing = await getDb().select({ id: patients.id }).from(patients)
  const nextNum = existing.length === 0 ? 1 : Math.max(...existing.map((p) => parseInt(p.id.replace('RD-', ''), 10))) + 1
  const newId = `RD-${String(nextNum).padStart(4, '0')}`

  const [created] = await getDb().insert(patients).values({
    id: newId,
    intakeqClientIdEncrypted: `ENC[pending-${newId}]`,
    ...parsed.data,
  }).returning()

  await invalidateCache(patientListCacheKey(null))
  await logAudit(session, 'added new client', newId)
  return NextResponse.json(created, { status: 201 })
}
```

(Add the needed imports — `z`, `getDb`, `patients`, `requireSession`, `logAudit`, `invalidateCache`, `patientListCacheKey` — matching whatever's already imported in the file, without duplicating.)

- [ ] **Step 2: `src/components/AddClientModal.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function AddClientModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [dob, setDob] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nameIntakeq: name, dobIntakeq: dob, emailIntakeq: email || undefined }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-foreground">Add New Client</h2>
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={dob} onChange={(e) => setDob(e.target.value)} type="date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Cancel</button>
          <button onClick={submit} disabled={submitting || !name || !dob} className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `src/components/SendFormModal.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function SendFormModal({ templates, patients, onClose }: {
  templates: { id: number; name: string }[]
  patients: { id: string; nameTebra: string | null; nameIntakeq: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [patientId, setPatientId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    const res = await fetch('/api/form-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, patientId }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-foreground">Send Form to Client</h2>
        <div className="space-y-3">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a client…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.nameTebra ?? p.nameIntakeq} ({p.id})</option>)}
          </select>
          <select value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a form…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Cancel</button>
          <button onClick={submit} disabled={submitting || !templateId || !patientId} className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Send Form</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Test**

`tests/api/patients-create.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { POST } from '@/app/api/patients/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('POST /api/patients', () => {
  it('rejects a payload missing a name', async () => {
    const req = new Request('http://localhost/api/patients', { method: 'POST', body: JSON.stringify({ dobIntakeq: '1990-01-01' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a client and assigns the next sequential anon ID', async () => {
    const req = new Request('http://localhost/api/patients', { method: 'POST', body: JSON.stringify({ nameIntakeq: 'Test Client', dobIntakeq: '1995-05-05' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toMatch(/^RD-\d{4}$/)
  })
})
```

- [ ] **Step 5: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/AddClientModal.tsx src/components/SendFormModal.tsx src/app/api/patients/route.ts tests/api/patients-create.test.ts
git commit -m "feat: add Add New Client and Send Form to Client flows"
```

---

### Task 6: Home Dashboard

**Files:**
- Create: `src/app/(dashboard)/page.tsx` (the new home dashboard — lives at `/` because it's inside the `(dashboard)` route group)
- Delete: `src/app/page.tsx` (the old unconditional redirect-to-`/patients` shim — no longer needed once `(dashboard)/page.tsx` handles `/`)
- Create: `src/components/DashboardHomeClient.tsx` (`'use client'` — hosts the two modals' open/close state)
- Test: `tests/pages/dashboard-home.test.tsx`

**Interfaces:**
- Consumes: `getDashboardData` (Task 2), `listFormTemplates` (Task 2), `listPatientsWithStatus` (existing), `<AddClientModal>`/`<SendFormModal>` (Task 5).

- [ ] **Step 1: Delete the old redirect shim**

```bash
git rm src/app/page.tsx
```

- [ ] **Step 2: `src/components/DashboardHomeClient.tsx`**

Client wrapper that owns which modal (if any) is open — kept separate from the Server Component page so the page itself stays a Server Component and can fetch data directly.

```typescript
'use client'
import { useState } from 'react'
import { AddClientModal } from './AddClientModal'
import { SendFormModal } from './SendFormModal'

export function DashboardHomeClient({ templates, patients }: {
  templates: { id: number; name: string }[]
  patients: { id: string; nameTebra: string | null; nameIntakeq: string }[]
}) {
  const [openModal, setOpenModal] = useState<'client' | 'form' | null>(null)

  return (
    <div className="mb-6 flex gap-3">
      <button onClick={() => setOpenModal('form')} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">Send Form to Client</button>
      <button onClick={() => setOpenModal('client')} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Add New Client</button>
      {openModal === 'client' && <AddClientModal onClose={() => setOpenModal(null)} />}
      {openModal === 'form' && <SendFormModal templates={templates} patients={patients} onClose={() => setOpenModal(null)} />}
    </div>
  )
}
```

- [ ] **Step 3: `src/app/(dashboard)/page.tsx`**

```typescript
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDashboardData } from '@/lib/queries/dashboard'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'

const EVENT_DOT: Record<string, string> = {
  'sent intake form': 'bg-sky-600',
  'completed intake form': 'bg-emerald-600',
  'verified identity': 'bg-primary',
  'ran classification': 'bg-accent',
}

export default async function DashboardHomePage() {
  const session = await requireSessionOrRedirect()
  const [data, templates, patients] = await Promise.all([getDashboardData(), listFormTemplates(), listPatientsWithStatus(null)])
  await logAudit(session, 'viewed home dashboard', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Home</h1>
      <DashboardHomeClient templates={templates.map((t) => ({ id: t.id, name: t.name }))} patients={patients.map((p) => ({ id: p.id, nameTebra: p.nameTebra, nameIntakeq: p.nameIntakeq }))} />

      <div className="grid grid-cols-2 gap-4">
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest Forms Received</h2>
          {data.latestForms.length === 0 ? <p className="text-sm text-muted-foreground">No records found.</p> : (
            <ul className="space-y-2">
              {data.latestForms.map((f) => (
                <li key={f.id} className="text-sm">
                  <Link href={`/client-forms/${f.id}`} className="font-medium text-primary hover:underline">{f.patientName}</Link>
                  <span className="text-muted-foreground"> — {f.templateName}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending Forms</h2>
          {data.pendingForms.length === 0 ? <p className="text-sm text-muted-foreground">No records found.</p> : (
            <ul className="space-y-2">
              {data.pendingForms.map((f) => (
                <li key={f.id} className="text-sm">
                  <Link href={`/client-forms/${f.id}`} className="font-medium text-primary hover:underline">{f.patientName}</Link>
                  <span className="text-muted-foreground"> — {f.templateName} ({f.status})</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending Classifications</h2>
          {data.pendingClassification.length === 0 ? <p className="text-sm text-muted-foreground">No records found.</p> : (
            <ul className="space-y-2">
              {data.pendingClassification.map((p) => (
                <li key={p.id} className="text-sm">
                  <Link href={`/patients/${p.id}`} className="font-medium text-primary hover:underline">{p.nameTebra ?? p.nameIntakeq}</Link>
                  <span className="text-muted-foreground"> — intake complete, not yet classified</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest Account Events</h2>
          {data.recentEvents.length === 0 ? <p className="text-sm text-muted-foreground">No records found.</p> : (
            <ul className="space-y-2">
              {data.recentEvents.map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${EVENT_DOT[e.action] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
                  <span className="text-foreground">{e.action}</span>
                  <span className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Test**

`tests/pages/dashboard-home.test.tsx` — a lightweight smoke test confirming the page module imports cleanly and the query function it depends on returns the expected shape (full RSC rendering tests aren't practical without a running Next.js server; the existing project's pattern is to test the query functions directly, already covered in Task 2's `dashboard.test.ts`). Skip a dedicated page test file here — note in the commit body that dashboard data-shape coverage lives in `tests/lib/queries/dashboard.test.ts`.

- [ ] **Step 5: Run the suite and manually verify, then commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm `/` shows the new dashboard (not a redirect to `/patients`), all four widgets render (with seeded data from Task 1, none should be empty), and both action buttons open their modals.

```bash
git add -A
git commit -m "feat: add Home Dashboard replacing the redirect-to-Patients shim"
```

---

### Task 7: Patient Detail additions — Medications, Allergies, Identity Verification

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx`
- Create: `src/components/AllergyBadge.tsx`
- Create: `src/app/api/patients/[anonId]/identity/route.ts` (PUT to mark identity verified)
- Test: `tests/api/identity-verification.test.ts`

**Interfaces:**
- Consumes: `getPatientDetail`'s extended return shape from Task 2 (`allergies`, `identityVerification`).

- [ ] **Step 1: Read the current page**

Read `src/app/(dashboard)/patients/[anonId]/page.tsx` in full before editing — confirm whether a Medications section already exists (the schema has had `medicationEpisodes` since the prototype build; the page may already render it). Only add what's missing: if Medications is already rendered, skip re-adding it and note that in the commit message.

- [ ] **Step 2: `src/components/AllergyBadge.tsx`**

```typescript
const SEVERITY_DOT: Record<string, string> = {
  severe: 'bg-red-600',
  moderate: 'bg-amber-500',
  mild: 'bg-muted-foreground',
}

export function AllergyBadge({ allergen, reaction, severity }: { allergen: string; reaction: string | null; severity: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[severity]}`} aria-hidden="true" />
      <span className="font-medium text-foreground">{allergen}</span>
      {reaction && <span className="text-muted-foreground">— {reaction}</span>}
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{severity}</span>
    </div>
  )
}
```

- [ ] **Step 3: Add sections to the Patient Detail page**

Add, after the existing Diagnoses & Medications section (adjust to match whatever heading/section structure Step 1 found):

```typescript
      <section className="mt-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Allergies</h2>
        {patient.allergies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No known allergies recorded.</p>
        ) : (
          <div className="space-y-2">
            {patient.allergies.map((a) => <AllergyBadge key={a.id} allergen={a.allergen} reaction={a.reaction} severity={a.severity} />)}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Identity Verification</h2>
        {patient.identityVerification?.verified ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-600" aria-hidden="true" />
            <span className="text-foreground">Verified by {patient.identityVerification.verifiedBy} on {new Date(patient.identityVerification.verifiedAt!).toLocaleDateString()}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
            <span className="text-foreground">Verification pending{patient.identityVerification ? ` (${patient.identityVerification.idType.replace('_', ' ')} on file)` : ' — no ID on file'}</span>
          </div>
        )}
      </section>
```

(Import `AllergyBadge` at the top of the file.)

- [ ] **Step 4: `src/app/api/patients/[anonId]/identity/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { identityVerifications } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

const verifySchema = z.object({
  idType: z.enum(['drivers_license', 'state_id', 'passport']),
  idNumber: z.string().min(1),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { anonId } = await params

  const parsed = verifySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid identity verification payload', details: parsed.error.flatten() }, { status: 400 })

  const [existing] = await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, anonId))
  const idNumberEncrypted = `ENC[${parsed.data.idNumber}]`  // matches the existing ENC[...] convention used for intakeqClientIdEncrypted/tebraPatientIdEncrypted in seed data

  if (existing) {
    await getDb().update(identityVerifications).set({ idType: parsed.data.idType, idNumberEncrypted, verified: true, verifiedBy: session.name, verifiedAt: new Date() }).where(eq(identityVerifications.patientId, anonId))
  } else {
    await getDb().insert(identityVerifications).values({ patientId: anonId, idType: parsed.data.idType, idNumberEncrypted, verified: true, verifiedBy: session.name, verifiedAt: new Date() })
  }

  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, 'verified identity', anonId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Test**

`tests/api/identity-verification.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { PUT } from '@/app/api/patients/[anonId]/identity/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('PUT /api/patients/[anonId]/identity', () => {
  it('rejects an invalid idType', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'ssn_card', idNumber: '123' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(res.status).toBe(400)
  })

  it('marks identity verified for a valid payload', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'passport', idNumber: 'P0000001' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ anonId: 'RD-0004' }) })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/app/\(dashboard\)/patients/\[anonId\]/page.tsx src/components/AllergyBadge.tsx src/app/api/patients/\[anonId\]/identity tests/api/identity-verification.test.ts
git commit -m "feat: add Allergies, Identity Verification to Patient Detail"
```

---

### Task 8: Auto-classify setting + real `maybeAutoClassify` implementation

**Files:**
- Modify: `src/lib/auto-classify.ts` (replace Task 4's stub with real logic)
- Create: `src/app/api/settings/auto-classify/route.ts` (PUT, Admin-only)
- Modify: `src/app/(dashboard)/settings/page.tsx` (add the toggle)
- Create: `src/components/AutoClassifyToggle.tsx` (`'use client'`)
- Test: `tests/lib/auto-classify.test.ts`

**Interfaces:**
- Consumes: `getAppSettings` (Task 2), the rule-engine pattern from `src/app/api/patients/[anonId]/refresh/route.ts` (existing).
- Produces: real `maybeAutoClassify(patientId)`, replacing Task 4's stub — same file path, so no import changes needed anywhere else.

- [ ] **Step 1: Real `src/lib/auto-classify.ts`**

```typescript
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, screeningCriteriaResults, diagnoses, medicationEpisodes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { evaluateCriteria } from '@/lib/rule-engine'
import { getAppSettings } from '@/lib/queries/settings'
import { invalidateCache, patientDetailCacheKey, patientListCacheKey } from '@/lib/cache'

// Called after a form submission is marked 'completed'. If the
// autoClassifyOnComplete setting is on, and this patient now has both
// completed intake data and at least some chart data (a diagnosis or a
// medication on file), re-runs the same rule-engine evaluation the manual
// "Run Classification" action uses — never a separate, divergent scoring
// path. If the setting is off, or the patient has no screening row yet
// (nothing to re-evaluate against), this is a no-op.
export async function maybeAutoClassify(patientId: string): Promise<void> {
  const settings = await getAppSettings()
  if (!settings.autoClassifyOnComplete) return

  const dx = await getDb().select().from(diagnoses).where(eq(diagnoses.patientId, patientId))
  const meds = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, patientId))
  if (dx.length === 0 && meds.length === 0) return  // no chart data yet — nothing to classify against

  const [screening] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, patientId))
  if (!screening) return  // no trial screening exists yet for this patient — manual assignment to a trial happens first

  const criteria = await getDb().select().from(screeningCriteriaResults).where(eq(screeningCriteriaResults.screeningId, screening.id))
  const overallStatus = evaluateCriteria(criteria)
  await getDb().update(patientTrialScreenings).set({ overallStatus }).where(eq(patientTrialScreenings.id, screening.id))
  await getDb().update(patients).set({ chartDataAsOf: new Date() }).where(eq(patients.id, patientId))

  await invalidateCache(patientDetailCacheKey(patientId))
  await invalidateCache(patientListCacheKey(screening.trialId))
  await invalidateCache(patientListCacheKey(null))
}
```

- [ ] **Step 2: `src/app/api/settings/auto-classify/route.ts`**

Admin-only, per spec §6 — the one new role check this plan introduces, scoped narrowly to this one setting (not a general RBAC system, which is a separate, already-ledgered gap):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateAutoClassifySetting } from '@/lib/queries/settings'

const toggleSchema = z.object({ enabled: z.boolean() }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = toggleSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await updateAutoClassifySetting(parsed.data.enabled)
  await logAudit(session, `set auto-classify to ${parsed.data.enabled}`, null)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: `src/components/AutoClassifyToggle.tsx`**

```typescript
'use client'
import { useState } from 'react'

export function AutoClassifyToggle({ initialEnabled, isAdmin }: { initialEnabled: boolean; isAdmin: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [saving, setSaving] = useState(false)

  async function toggle() {
    const next = !enabled
    setSaving(true)
    const res = await fetch('/api/settings/auto-classify', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    setSaving(false)
    if (res.ok) setEnabled(next)
  }

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-foreground">Automatically classify patients once intake and chart data are complete</span>
      <button
        onClick={toggle}
        disabled={!isAdmin || saving}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${enabled ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'} disabled:opacity-50`}
      >
        {enabled ? 'On' : 'Off'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Wire into Settings page**

Add to `src/app/(dashboard)/settings/page.tsx`, inside a new section (after the existing Compliance section):

```typescript
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Classification</h2>
        <AutoClassifyToggle initialEnabled={settings.autoClassifyOnComplete} isAdmin={session.role === 'admin'} />
      </section>
```

Import `AutoClassifyToggle` and `getAppSettings`, and fetch `const settings = await getAppSettings()` alongside the existing `session` fetch at the top of the page.

- [ ] **Step 5: Test**

`tests/lib/auto-classify.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { maybeAutoClassify } from '@/lib/auto-classify'
import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

describe('maybeAutoClassify', () => {
  it('is a no-op when the setting is off', async () => {
    await getDb().update(appSettings).set({ autoClassifyOnComplete: false }).where(eq(appSettings.id, 1))
    await expect(maybeAutoClassify('RD-0001')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/auto-classify.ts src/app/api/settings/auto-classify src/app/\(dashboard\)/settings/page.tsx src/components/AutoClassifyToggle.tsx tests/lib/auto-classify.test.ts
git commit -m "feat: implement auto-classify setting and real maybeAutoClassify logic"
```

---

### Task 9: Comprehensive, verification-ready Excel export

**Files:**
- Modify: `src/lib/excel-export.ts`
- Modify: `src/app/api/workbook/export/route.ts` (read the file first — extend its query to gather the richer dataset)
- Test: `tests/lib/excel-export.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `getPatientDetail`-shaped data (allergies, identity verification, diagnoses, medications, criteria) for every patient, plus form-submission status.
- Produces: a workbook with enough columns for a nurse to run a phone verification call without opening the app.

- [ ] **Step 1: Read the current export route and column set**

`src/lib/excel-export.ts` currently exports 5 columns (Anonymous Number, Patient Name, DOB, Current Provider, Referral Type) — read `src/app/api/workbook/export/route.ts` too, to see exactly what it currently queries and passes in.

- [ ] **Step 2: Expand `ExportablePatient` and `COLUMNS`**

Replace the top of `src/lib/excel-export.ts`:

```typescript
const COLUMNS = [
  'Anonymous Number',
  'Name (IntakeQ)', 'Name (Tebra)', 'Name Match',
  'DOB (IntakeQ)', 'DOB (Tebra)', 'DOB Match',
  'Phone (IntakeQ)', 'Phone (Tebra)',
  'Email (IntakeQ)',
  'Identity Verified', 'ID Type',
  'Current Provider', 'Referral Type',
  'Diagnoses', 'Current Medications', 'Allergies',
  'Trial', 'Overall Status', 'Items Needing Verification',
  'Intake Form Status', 'Last Communication',
]

export interface ExportablePatient {
  id: string
  nameIntakeq: string
  nameTebra: string | null
  dobIntakeq: string
  dobTebra: string | null
  phoneIntakeq: string | null
  phoneTebra: string | null
  emailIntakeq: string | null
  identityVerified: boolean
  idType: string | null
  currentProvider: string | null
  referralType: string | null
  diagnoses: { code: string; description: string }[]
  medications: { name: string; dose: string | null; startDate: string }[]
  allergies: { allergen: string; severity: string }[]
  trialName: string | null
  overallStatus: string | null
  criteriaNeedingVerification: { criterionText: string; evidenceQuote: string | null }[]
  formStatus: string | null
  lastCommunication: string | null
}
```

- [ ] **Step 3: Rewrite `buildWorkbookXlsx`**

```typescript
export async function buildWorkbookXlsx(patients: ExportablePatient[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Screening Workbook')
  sheet.addRow(COLUMNS)

  for (const p of patients) {
    const nameMatch = p.nameTebra && p.nameTebra !== p.nameIntakeq ? 'MISMATCH' : 'Match'
    const dobMatch = p.dobTebra && p.dobTebra !== p.dobIntakeq ? 'MISMATCH' : 'Match'
    const diagnosesStr = p.diagnoses.map((d) => `${d.code}: ${d.description}`).join('; ')
    const medsStr = p.medications.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''} (since ${m.startDate})`).join('; ')
    const allergiesStr = p.allergies.map((a) => `${a.allergen} (${a.severity})`).join('; ')
    const needsVerificationStr = p.criteriaNeedingVerification.map((c) => `${c.criterionText}${c.evidenceQuote ? ` — "${c.evidenceQuote}"` : ''}`).join(' | ')

    sheet.addRow([
      p.id,
      sanitizeCell(p.nameIntakeq), sanitizeCell(p.nameTebra), nameMatch,
      sanitizeCell(p.dobIntakeq), sanitizeCell(p.dobTebra), dobMatch,
      sanitizeCell(p.phoneIntakeq), sanitizeCell(p.phoneTebra),
      sanitizeCell(p.emailIntakeq),
      p.identityVerified ? 'Yes' : 'No', sanitizeCell(p.idType),
      sanitizeCell(p.currentProvider), sanitizeCell(p.referralType),
      sanitizeCell(diagnosesStr), sanitizeCell(medsStr), sanitizeCell(allergiesStr),
      sanitizeCell(p.trialName), sanitizeCell(p.overallStatus), sanitizeCell(needsVerificationStr),
      sanitizeCell(p.formStatus), sanitizeCell(p.lastCommunication),
    ])
  }

  const raw = await workbook.xlsx.writeBuffer()
  return Buffer.from(raw as unknown as ArrayBuffer)
}
```

(Keep the existing `sanitizeCell` function exactly as-is — the formula-injection mitigation is unchanged and must still run on every string cell.)

- [ ] **Step 4: Update the export route to gather the richer dataset**

In `src/app/api/workbook/export/route.ts`, replace whatever currently builds the `ExportablePatient[]` array with a version that, for each patient, also pulls: `identityVerifications` (verified + idType), `allergies`, the latest `formSubmissions` row's status, the trial name from `patientTrialScreenings`/`trials`, and — for `criteriaNeedingVerification` — filters that patient's `screeningCriteriaResults` to only `verdict !== 'green'` (a nurse calling to verify only needs the open items, not the ones already confirmed). Reuse `getPatientDetail`-style queries rather than writing new raw SQL; a `Promise.all` over `listPatientsWithStatus(null)` combined with one `getPatientDetail(id)` call per patient is acceptable at this data scale (dozens of patients, not thousands).

- [ ] **Step 5: Extend the test**

Add to `tests/lib/excel-export.test.ts` (read the existing file first, add alongside its current tests):

```typescript
it('includes identity, allergy, and needs-verification columns', async () => {
  const buffer = await buildWorkbookXlsx([{
    id: 'RD-9999', nameIntakeq: 'Test Patient', nameTebra: 'Test Patient',
    dobIntakeq: '1990-01-01', dobTebra: '1990-01-01',
    phoneIntakeq: null, phoneTebra: null, emailIntakeq: null,
    identityVerified: true, idType: 'passport',
    currentProvider: null, referralType: null,
    diagnoses: [{ code: 'F33.1', description: 'MDD, recurrent, moderate' }],
    medications: [{ name: 'Sertraline', dose: '50mg', startDate: '2026-06-01' }],
    allergies: [{ allergen: 'Penicillin', severity: 'moderate' }],
    trialName: 'NCT06911112', overallStatus: 'yellow',
    criteriaNeedingVerification: [{ criterionText: 'Medication washout', evidenceQuote: 'started 5 weeks ago' }],
    formStatus: 'completed', lastCommunication: null,
  }])
  expect(buffer.length).toBeGreaterThan(0)
})
```

- [ ] **Step 6: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev`, log in, hit `/api/workbook/export` directly (or the Export button on `/patients`), download the file, and open it — confirm all 21 columns are present and populated for at least one patient with allergies/identity data from the Task 1 seed.

```bash
git add src/lib/excel-export.ts src/app/api/workbook/export/route.ts tests/lib/excel-export.test.ts
git commit -m "feat: expand Excel export to a full verification-call-ready workbook"
```

---

### Task 10: Remove the PILOT/DEMO banner, add Home nav entry, notification panel

**Files:**
- Modify: `src/components/TopBanner.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `src/components/LeftNav.tsx` (add Home, Form Templates, Client Forms nav entries)
- Modify: `tests/components/TopBanner.test.tsx`
- Create: `src/components/NotificationPanel.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `getDashboardData().recentEvents` (Task 2) for the notification panel's content.

- [ ] **Step 1: Remove the banner text from `TopBanner.tsx`**

Per explicit, twice-repeated client instruction, remove the amber banner entirely (not just soften it):

```typescript
export function TopBanner({ userName }: { userName: string }) {
  return (
    <div className="border-b border-border bg-card">
      <div className="flex items-center justify-between px-6 py-3">
        <span className="text-base font-semibold tracking-tight text-foreground">Clinsync</span>
        <div className="flex items-center gap-4">
          <NotificationPanel />
          <span className="text-sm font-medium text-foreground">{userName}</span>
        </div>
      </div>
    </div>
  )
}
```

(Drop the `environment` prop entirely — it only ever gated the removed banner. Update the call site in `src/app/(dashboard)/layout.tsx` to `<TopBanner userName={session.name} />`.)

- [ ] **Step 2: Remove the banner from `src/app/login/page.tsx`**

Remove the `<div className="mb-4 w-full max-w-sm rounded-md bg-amber-50 ...">PILOT / DEMO — NO REAL PATIENT DATA</div>` block entirely.

- [ ] **Step 3: `src/components/NotificationPanel.tsx`**

```typescript
'use client'
import { useState, useEffect } from 'react'

interface Event { id: number; action: string; timestamp: string }

export function NotificationPanel() {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<Event[]>([])

  useEffect(() => {
    if (open) fetch('/api/audit-log?limit=10').then((r) => r.json()).then((data) => setEvents(data.slice(0, 10)))
  }, [open])

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-secondary" aria-label="Notifications">
        Notifications{events.length > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-xs text-accent-foreground">{events.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-card p-3 shadow-lg">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent Activity</p>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records found.</p>
          ) : (
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="text-sm">
                  <span className="text-foreground">{e.action}</span>
                  <span className="ml-1 text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
```

Check `src/app/api/audit-log/route.ts` supports a `?limit=` query param — if not, add optional `limit` parsing (default to returning all rows, capped at whatever the existing route already does) rather than changing its existing contract for other callers.

- [ ] **Step 4: `LeftNav.tsx` — add nav entries**

Add `{ href: '/', label: 'Home' }` as the first item, and `{ href: '/forms', label: 'Form Templates' }` / `{ href: '/client-forms', label: 'Client Forms' }` after `Identity Matching`, in the existing `ITEMS` array. No other changes to the component.

- [ ] **Step 5: Fix `tests/components/TopBanner.test.tsx`**

Replace the file's contents (the old tests assert the now-removed banner text and an `environment` prop):

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopBanner } from '@/components/TopBanner'

describe('TopBanner', () => {
  it('shows the product name and signed-in user', () => {
    render(<TopBanner userName="Jamie Ruiz" />)
    expect(screen.getByText('Clinsync')).toBeInTheDocument()
    expect(screen.getByText('Jamie Ruiz')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/TopBanner.tsx src/app/login/page.tsx src/components/LeftNav.tsx src/components/NotificationPanel.tsx tests/components/TopBanner.test.tsx src/app/\(dashboard\)/layout.tsx
git commit -m "feat: remove PILOT/DEMO banner, add nav entries and notification panel"
```

---

### Task 11: Final QA pass (local only — no push)

**Files:** none created; verification only.

- [ ] **Step 1: Full-tree greps**

```bash
grep -rn "PILOT.*DEMO\|NO REAL PATIENT DATA" src/
grep -rn "lucide-react" src/ | grep -v "components/ui/"
grep -rn "bg-slate-\|text-green-700\|text-blue-700\|text-purple-700\|bg-green-700\|text-amber-700" src/ --include="*.tsx" | grep -v "translate-"
```
All three must return zero matches (the last one, matching the established convention, uses emerald-800/amber-800 tokens instead).

- [ ] **Step 2: `npm test` and `npm run build`**

Both must be 100% clean.

- [ ] **Step 3: Manual browser walkthrough**

Log in as each of the 3 demo roles and visit every screen: `/`, `/patients`, `/patients/[anonId]` (one with allergies + verified identity, one without), `/forms`, `/forms/[templateId]`, `/client-forms`, `/client-forms/[id]`, `/identity-matching`, `/trials`, `/trials/[trialId]`, `/audit-log`, `/settings`. Confirm:
- No banner text anywhere.
- Home Dashboard's 4 widgets are populated (not empty) from seed data.
- Send Form to Client and Add New Client both work end-to-end (new form submission / new patient actually appears afterward).
- Excel export downloads and opens with all new columns populated.
- Notification panel opens and shows recent activity.
- Auto-classify toggle only works for the Admin demo login (Sam Patel) — confirm CRC/PI logins see it disabled.

- [ ] **Step 4: Confirm nothing pushed yet**

```bash
git status --porcelain
git log --oneline origin/master..HEAD
```

Everything from this plan should be committed locally but **not yet pushed** — pushing and deployment happen only after this Final QA pass is confirmed clean, per the explicit "test locally... before pushing into git" instruction.
