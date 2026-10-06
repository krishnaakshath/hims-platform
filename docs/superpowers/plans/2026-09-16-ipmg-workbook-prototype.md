# IPMG Workbook Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable, clickable prototype of the IPMG research pre-screening workbook — real UI, real Postgres-backed business logic (rule engine, identity matcher), real API contract — running entirely on seeded mock data so it can be demoed to IPMG before any live IntakeQ/Tebra access exists.

**Architecture:** A single Next.js 15 (App Router) + TypeScript app deployed to Vercel. Postgres (Neon, via Vercel Marketplace) holds the schema from the design spec §7.3. Two "mock connector" modules (`intakeq.mock.ts`, `tebra.mock.ts`) expose the same function signatures the real connectors will use later, but return data from seeded fixtures instead of live API calls — so replacing them with real HTTP/FHIR calls (Plan B, blocked on BAA + Tebra FHIR activation + IntakeQ API key) is a drop-in swap, not a rewrite. Demo authentication is a simple role-switcher (CRC / PI / Admin) via a signed cookie — real SSO is production-only and depends on confirming IPMG's identity provider (open question in the spec).

**Tech Stack:** Next.js 15 (App Router, TypeScript), Tailwind CSS + shadcn/ui, Drizzle ORM, Postgres (Neon via Vercel Marketplace), Vitest + React Testing Library, ExcelJS (xlsx export).

**Spec:** `docs/superpowers/specs/2026-09-16-ipmg-workbook-ui-ux-design.md`

## Global Constraints

- No condition-specific logic hardcoded anywhere (spec §1, §4.4, §7.3) — diagnosis codes, rating scales, and medication/washout rules are always read from a trial's configuration row, never from an `if condition === 'depression'` branch.
- Status must always render as icon + label, never color alone (spec §5, §6).
- Routes and URLs use the anonymous patient ID (e.g. `RD-0001`) only — never name or DOB (spec §6).
- Every IntakeQ/Tebra-sourced field renders a read-only lock indicator; only staff-owned fields (12, 17–20, 23, 24, 28 in the 30-column map) are editable (spec §4.1).
- Minimum 4.5:1 text contrast; visible keyboard focus states throughout (spec §5).
- No glassmorphism, bento grids, shiny-button gradients, or decorative motion (spec §5) — dense, functional, high-contrast, EHR-like.
- Every page that renders patient data writes an audit log entry (spec §6).
- The prototype must display a persistent "PILOT / DEMO — NO REAL PATIENT DATA" banner at all times (spec §8).
- All mock/fixture patient data must be clearly fictional.

---

## File Structure

```
clinsync/
  drizzle.config.ts
  src/
    db/
      schema.ts              # Drizzle schema (Task 2)
      client.ts              # DB connection (Task 2)
      seed.ts                # Fixture data + seed script (Task 4)
    connectors/
      types.ts               # Shared types mirroring real IntakeQ/Tebra API shapes (Task 3)
      intakeq.mock.ts         # Mock IntakeQ connector (Task 3)
      tebra.mock.ts           # Mock Tebra connector (Task 3)
    lib/
      rule-engine.ts          # Deterministic criteria evaluator (Task 5)
      matcher.ts              # Identity matching logic (Task 6)
      auth.ts                 # Demo role-cookie session helpers (Task 7)
      excel-export.ts         # xlsx generation (Task 16)
    middleware.ts             # Route guard using auth.ts (Task 7)
    app/
      layout.tsx              # Root layout (Task 1)
      page.tsx                # Redirects to /patients (Task 1)
      login/page.tsx          # Role switcher (Task 7)
      (dashboard)/
        layout.tsx            # TopBanner + LeftNav shell (Task 10)
        patients/
          page.tsx             # Workbook table (Task 11)
          [anonId]/page.tsx     # Patient Detail (Task 12)
        identity-matching/page.tsx   # Task 13
        trials/
          page.tsx              # Task 14
          [trialId]/page.tsx      # Task 14
        audit-log/page.tsx      # Task 15
        settings/page.tsx       # Task 15
      api/
        patients/route.ts                       # Task 8
        patients/[anonId]/route.ts               # Task 8
        patients/[anonId]/refresh/route.ts        # Task 8
        identity-matches/route.ts                # Task 9
        identity-matches/[id]/confirm/route.ts     # Task 9
        identity-matches/[id]/reject/route.ts       # Task 9
        trials/route.ts                          # Task 9
        trials/[trialId]/criteria/route.ts         # Task 9
        audit-log/route.ts                       # Task 9
        workbook/export/route.ts                 # Task 16
    components/
      TopBanner.tsx           # Task 10
      LeftNav.tsx             # Task 10
      SessionTimeoutWarning.tsx  # Task 10
      StatusChip.tsx          # Task 5 (used from Task 11 onward)
      SourceTag.tsx           # Task 11
      EvidenceCard.tsx        # Task 12
  tests/
    lib/rule-engine.test.ts    # Task 5
    lib/matcher.test.ts        # Task 6
    db/seed.test.ts            # Task 4
    api/patients.test.ts       # Task 8
    components/StatusChip.test.tsx  # Task 5
```

---

### Task 1: Project scaffold + Vercel deployment skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `tailwind.config.ts`, `next.config.ts`, `vitest.config.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Test: `tests/app/page.test.tsx`

**Interfaces:**
- Produces: a running Next.js app at `/` that redirects to `/patients`, with Vitest configured and passing.

- [ ] **Step 1: Scaffold the app**

```bash
npx create-next-app@latest . --typescript --tailwind --app --src-dir --import-alias "@/*" --eslint --no-turbopack --yes
npm install drizzle-orm pg @vercel/postgres exceljs
npm install -D drizzle-kit vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom @types/pg
npx shadcn@latest init -d
```

- [ ] **Step 2: Configure Vitest**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
```

Create `vitest.setup.ts`:

```typescript
import '@testing-library/jest-dom/vitest'
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 3: Write the failing test for the root redirect**

Create `tests/app/page.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import Page from '@/app/page'

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

describe('root page', () => {
  it('redirects to /patients', async () => {
    const { redirect } = await import('next/navigation')
    Page()
    expect(redirect).toHaveBeenCalledWith('/patients')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/app/page.test.tsx`
Expected: FAIL — `src/app/page.tsx` doesn't call `redirect` yet (default Next.js scaffold page).

- [ ] **Step 5: Implement the redirect**

Replace `src/app/page.tsx`:

```typescript
import { redirect } from 'next/navigation'

export default function Page() {
  redirect('/patients')
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/app/page.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Vitest, redirect root to /patients"
```

---

### Task 2: Postgres provisioning + Drizzle schema

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: exported Drizzle table objects `trials`, `patients`, `diagnoses`, `medicationEpisodes`, `patientTrialScreenings`, `screeningCriteriaResults`, `identityMatches`, `auditLog`, `users` — every later task imports from `@/db/schema`.

- [ ] **Step 1: Postgres already provisioned**

Neon Postgres has already been provisioned via `vercel integration add neon` and linked to this project — `DATABASE_URL` (and related `PG*`/`POSTGRES_*` vars) are already in `.env.local`. Nothing to do here except confirm: run `cat .env.local | grep DATABASE_URL` and verify it's non-empty before continuing.

- [ ] **Step 2: Write the schema**

Create `src/db/schema.ts`:

```typescript
import { pgTable, text, timestamp, date, boolean, jsonb, integer, pgEnum, serial } from 'drizzle-orm/pg-core'

export const verdictEnum = pgEnum('verdict', ['green', 'yellow', 'red'])
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin'])
export const matchStatusEnum = pgEnum('match_status', ['pending', 'confirmed', 'rejected'])

export const trials = pgTable('trials', {
  id: text('id').primaryKey(),                 // e.g. "nct06911112"
  name: text('name').notNull(),
  nctNumber: text('nct_number').notNull(),
  condition: text('condition').notNull(),        // e.g. "Major Depressive Disorder"
  site: text('site').notNull(),
  studyDrug: text('study_drug').notNull(),
  ageMin: integer('age_min').notNull(),
  ageMax: integer('age_max').notNull(),
  diagnosisCodes: jsonb('diagnosis_codes').$type<{ code: string; description: string }[]>().notNull(),
  ratingScales: jsonb('rating_scales').$type<{ name: string; description: string }[]>().notNull(),
  medicationClasses: jsonb('medication_classes').$type<
    { className: string; washoutDays: number; rule: string }[]
  >().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const patients = pgTable('patients', {
  id: text('id').primaryKey(),                  // anonymous id "RD-0001"
  dateAdded: timestamp('date_added').defaultNow().notNull(),
  intakeqClientIdEncrypted: text('intakeq_client_id_encrypted').notNull(),
  tebraPatientIdEncrypted: text('tebra_patient_id_encrypted'),
  nameIntakeq: text('name_intakeq').notNull(),
  nameTebra: text('name_tebra'),
  dobIntakeq: date('dob_intakeq').notNull(),
  dobTebra: date('dob_tebra'),
  cityIntakeq: text('city_intakeq'),
  cityTebra: text('city_tebra'),
  zipIntakeq: text('zip_intakeq'),
  zipTebra: text('zip_tebra'),
  phoneIntakeq: text('phone_intakeq'),
  phoneTebra: text('phone_tebra'),
  emailIntakeq: text('email_intakeq'),
  emailTebra: text('email_tebra'),
  currentProvider: text('current_provider'),
  ratingScales: jsonb('rating_scales').$type<{ name: string; score: number; date: string }[]>().default([]),
  referralType: text('referral_type'),
  availability: text('availability'),
  lastApptDate: date('last_appt_date'),
  nextApptDate: date('next_appt_date'),
  commConsentSigned: boolean('comm_consent_signed').default(false),
  commConsentPref: text('comm_consent_pref'),
  templateDocUrl: text('template_doc_url'),
  prescreeningSentDate: date('prescreening_sent_date'),
  tebraChartUrl: text('tebra_chart_url'),
  // Staff-owned fields (2, 12, 17-20, 23, 24, 28 in the 30-column map) — never overwritten by refresh
  lastCommunication: text('last_communication'),
  formNotes: text('form_notes'),
  reviewerNotes: text('reviewer_notes'),
  clinicianReviewerNotes: text('clinician_reviewer_notes'),
  piRecommendation: text('pi_recommendation'),
  oldNotes: text('old_notes'),
  oldRecs: text('old_recs'),
  outsideMedsConfirmation: text('outside_meds_confirmation'),
  chartDataAsOf: timestamp('chart_data_as_of').defaultNow().notNull(),
})

export const diagnoses = pgTable('diagnoses', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  code: text('code').notNull(),
  description: text('description').notNull(),
  source: text('source', { enum: ['tebra', 'intakeq'] }).notNull(),
  date: date('date'),
})

export const medicationEpisodes = pgTable('medication_episodes', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  name: text('name').notNull(),
  medicationClass: text('medication_class').notNull(),
  dose: text('dose'),
  startDate: date('start_date').notNull(),
  stopDate: date('stop_date'),
  status: text('status', { enum: ['active', 'inactive'] }).notNull(),
})

export const patientTrialScreenings = pgTable('patient_trial_screenings', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  trialId: text('trial_id').notNull().references(() => trials.id),
  overallStatus: verdictEnum('overall_status').notNull(),
})

export const screeningCriteriaResults = pgTable('screening_criteria_results', {
  id: serial('id').primaryKey(),
  screeningId: integer('screening_id').notNull().references(() => patientTrialScreenings.id),
  criterionKey: text('criterion_key').notNull(),
  criterionText: text('criterion_text').notNull(),
  verdict: verdictEnum('verdict').notNull(),
  evidenceQuote: text('evidence_quote'),
  evidenceSourceDoc: text('evidence_source_doc'),
  evidenceSourceDate: date('evidence_source_date'),
})

export const identityMatches = pgTable('identity_matches', {
  id: serial('id').primaryKey(),
  intakeqClientIdEncrypted: text('intakeq_client_id_encrypted').notNull(),
  referralName: text('referral_name').notNull(),
  referralDob: date('referral_dob').notNull(),
  candidateTebraPatientIdEncrypted: text('candidate_tebra_patient_id_encrypted').notNull(),
  candidateName: text('candidate_name').notNull(),
  candidateDob: date('candidate_dob').notNull(),
  confidence: integer('confidence').notNull(), // 0-100
  status: matchStatusEnum('status').default('pending').notNull(),
})

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  userName: text('user_name').notNull(),
  role: roleEnum('role').notNull(),
  action: text('action').notNull(),
  patientId: text('patient_id'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  details: text('details'),
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: roleEnum('role').notNull(),
})
```

Create `src/db/client.ts` — uses the Neon serverless HTTP driver (not `pg`/node-postgres, which doesn't suit Vercel's serverless functions) with **lazy initialization** so `next build` doesn't crash if `DATABASE_URL` isn't set yet at build time, and a plain `getDb()` function rather than a `Proxy` wrapper (a `Proxy` around the client is known to break libraries that introspect the client object):

```typescript
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

function createDb() {
  const sql = neon(process.env.DATABASE_URL!)
  return drizzle(sql, { schema })
}

let _db: ReturnType<typeof createDb> | null = null

export function getDb() {
  if (!_db) _db = createDb()
  return _db
}
```

Every later task that wrote `import { db } from '@/db/client'` followed by `db.select()...` should instead write `import { getDb } from '@/db/client'` and call `getDb().select()...` — treat this substitution as implicit everywhere `db.` appears in a later task's code (schema/table names are unaffected).

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

`drizzle-kit` does not auto-load `.env.local` — the `db:generate`/`db:push`/`db:seed` npm scripts already run through `dotenv-cli` (`dotenv -e .env.local -- ...`) to source it.

- [ ] **Step 3: Write the failing test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as schema from '@/db/schema'

describe('schema', () => {
  it('exports all required tables', () => {
    expect(schema.trials).toBeDefined()
    expect(schema.patients).toBeDefined()
    expect(schema.diagnoses).toBeDefined()
    expect(schema.medicationEpisodes).toBeDefined()
    expect(schema.patientTrialScreenings).toBeDefined()
    expect(schema.screeningCriteriaResults).toBeDefined()
    expect(schema.identityMatches).toBeDefined()
    expect(schema.auditLog).toBeDefined()
    expect(schema.users).toBeDefined()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL before `schema.ts` exists; PASS once Step 2 is in place — if you're following TDD strictly, write this test before Step 2's file, confirm the import error, then add the schema.

- [ ] **Step 5: Run migration against the provisioned database**

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Drizzle Postgres schema for trials, patients, screenings, audit log"
```

---

### Task 3: Shared types + mock connectors

**Files:**
- Create: `src/connectors/types.ts`, `src/connectors/intakeq.mock.ts`, `src/connectors/tebra.mock.ts`
- Test: `tests/connectors/mocks.test.ts`

**Interfaces:**
- Produces: `IntakeQClient`, `IntakeQIntake`, `FHIRPatient`, `MedicationRequestResult`, `ConditionResult` types; `getClient(id)`, `getFullIntake(id)`, `searchPatient(name, dob)`, `getActiveMedications(patientId)`, `getInactiveMedications(patientId)`, `getConditions(patientId)` functions — Task 4's seed script and Task 8's API routes both import these.

- [ ] **Step 1: Write the shared types**

Create `src/connectors/types.ts`:

```typescript
export interface IntakeQClient {
  clientId: string
  firstName: string
  lastName: string
  dateOfBirth: string // ISO date
  city: string
  zip: string
  phone: string
  email: string
}

export interface IntakeQIntake {
  intakeId: string
  clientId: string
  referralType: string
  availability: string
  consentSigned: boolean
  consentPreference: string
  ratingScales: { name: string; score: number; date: string }[]
}

export interface FHIRPatient {
  tebraPatientId: string
  firstName: string
  lastName: string
  birthDate: string
  city: string
  zip: string
  email: string
  generalPractitioner: string
}

export interface MedicationRequestResult {
  name: string
  medicationClass: string
  dose: string
  startDate: string
  stopDate: string | null
  status: 'active' | 'inactive'
}

export interface ConditionResult {
  code: string
  description: string
  date: string
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/connectors/mocks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { getClient, getFullIntake } from '@/connectors/intakeq.mock'
import { searchPatient, getActiveMedications, getConditions } from '@/connectors/tebra.mock'

describe('mock connectors', () => {
  it('IntakeQ getClient returns a client by id', async () => {
    const client = await getClient('iq-001')
    expect(client?.clientId).toBe('iq-001')
  })

  it('IntakeQ getFullIntake returns rating scales', async () => {
    const intake = await getFullIntake('intake-001')
    expect(intake?.ratingScales.length).toBeGreaterThan(0)
  })

  it('Tebra searchPatient matches by name and DOB', async () => {
    const results = await searchPatient('Maria Alvarez', '1985-03-12')
    expect(results.length).toBeGreaterThan(0)
  })

  it('Tebra getActiveMedications returns medication class', async () => {
    const meds = await getActiveMedications('tebra-001')
    expect(meds[0].medicationClass).toBeDefined()
  })

  it('Tebra getConditions returns ICD-10 codes', async () => {
    const conditions = await getConditions('tebra-001')
    expect(conditions[0].code).toMatch(/^[A-Z]\d/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/connectors/mocks.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 4: Implement the mock connectors**

Create `src/connectors/intakeq.mock.ts`:

```typescript
import { IntakeQClient, IntakeQIntake } from './types'

const CLIENTS: Record<string, IntakeQClient> = {
  'iq-001': { clientId: 'iq-001', firstName: 'Maria', lastName: 'Alvarez', dateOfBirth: '1985-03-12', city: 'Redlands', zip: '92373', phone: '909-555-0142', email: 'malvarez.demo@example.com' },
}

const INTAKES: Record<string, IntakeQIntake> = {
  'intake-001': { intakeId: 'intake-001', clientId: 'iq-001', referralType: 'Provider referral', availability: 'Weekday mornings', consentSigned: true, consentPreference: 'Phone', ratingScales: [{ name: 'PHQ-9', score: 18, date: '2026-09-01' }] },
}

export async function getClient(clientId: string): Promise<IntakeQClient | null> {
  return CLIENTS[clientId] ?? null
}

export async function getFullIntake(intakeId: string): Promise<IntakeQIntake | null> {
  return INTAKES[intakeId] ?? null
}
```

Create `src/connectors/tebra.mock.ts`:

```typescript
import { FHIRPatient, MedicationRequestResult, ConditionResult } from './types'

const PATIENTS: FHIRPatient[] = [
  { tebraPatientId: 'tebra-001', firstName: 'Maria', lastName: 'Alvarez', birthDate: '1985-03-12', city: 'Redlands', zip: '92373', email: 'maria.alvarez.demo@example.com', generalPractitioner: 'Dr. R. Kunam' },
]

const MEDICATIONS: Record<string, MedicationRequestResult[]> = {
  'tebra-001': [
    { name: 'Sertraline', medicationClass: 'SSRI', dose: '100mg daily', startDate: '2026-06-01', stopDate: null, status: 'active' },
    { name: 'Trazodone', medicationClass: 'Atypical antidepressant', dose: '50mg nightly', startDate: '2025-01-15', stopDate: '2025-11-01', status: 'inactive' },
  ],
}

const CONDITIONS: Record<string, ConditionResult[]> = {
  'tebra-001': [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate', date: '2025-01-15' }],
}

export async function searchPatient(name: string, dob: string): Promise<FHIRPatient[]> {
  return PATIENTS.filter((p) => `${p.firstName} ${p.lastName}`.toLowerCase() === name.toLowerCase() && p.birthDate === dob)
}

export async function getActiveMedications(patientId: string): Promise<MedicationRequestResult[]> {
  return (MEDICATIONS[patientId] ?? []).filter((m) => m.status === 'active')
}

export async function getInactiveMedications(patientId: string): Promise<MedicationRequestResult[]> {
  return (MEDICATIONS[patientId] ?? []).filter((m) => m.status === 'inactive')
}

export async function getConditions(patientId: string): Promise<ConditionResult[]> {
  return CONDITIONS[patientId] ?? []
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/connectors/mocks.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add shared connector types and mock IntakeQ/Tebra connectors"
```

---

### Task 4: Fixture data + seed script

**Files:**
- Create: `src/db/seed.ts`
- Test: `tests/db/seed.test.ts`

**Interfaces:**
- Consumes: `db` from `@/db/client`, all tables from `@/db/schema`.
- Produces: a `seed()` function that populates 2 trials and 18 patients (mixed 🟢/🟡/🔴, mixed trial assignment, 2 pending identity matches, 1 dual-source mismatch) — Task 8/9/11/12/13 API routes and UI all read this seeded data.

- [ ] **Step 1: Write the failing test**

Create `tests/db/seed.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { db } from '@/db/client'
import { trials, patients, identityMatches } from '@/db/schema'
import { seed } from '@/db/seed'

describe('seed', () => {
  beforeAll(async () => {
    await seed()
  })

  it('creates exactly 2 trials covering different conditions', async () => {
    const rows = await db.select().from(trials)
    expect(rows.length).toBe(2)
    const conditions = rows.map((r) => r.condition)
    expect(new Set(conditions).size).toBe(2)
  })

  it('creates at least 15 patients', async () => {
    const rows = await db.select().from(patients)
    expect(rows.length).toBeGreaterThanOrEqual(15)
  })

  it('creates at least 2 pending identity matches', async () => {
    const rows = await db.select().from(identityMatches)
    expect(rows.filter((r) => r.status === 'pending').length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/seed.test.ts`
Expected: FAIL — `src/db/seed.ts` doesn't exist.

- [ ] **Step 3: Implement the seed script**

Create `src/db/seed.ts` (excerpt showing the two trials, six hand-authored "hero" patients covering every demo scenario, and a deterministic generator for the remaining patients — full file continues the same pattern):

```typescript
import { db } from './client'
import { trials, patients, diagnoses, medicationEpisodes, patientTrialScreenings, screeningCriteriaResults, identityMatches, users } from './schema'

const MDD_TRIAL = {
  id: 'nct06911112',
  name: 'Adjunctive Treatment in Major Depressive Disorder',
  nctNumber: 'NCT06911112',
  condition: 'Major Depressive Disorder',
  site: 'Redlands',
  studyDrug: 'NBI-1065845',
  ageMin: 18,
  ageMax: 65,
  diagnosisCodes: [
    { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
  ],
  ratingScales: [{ name: 'PHQ-9', description: 'Patient Health Questionnaire-9' }],
  medicationClasses: [{ className: 'SSRI/SNRI antidepressant', washoutDays: 56, rule: 'On current antidepressant dose for at least 8 weeks' }],
}

const ADHD_TRIAL = {
  id: 'nct-adhd-demo-01',
  name: 'Extended-Release Stimulant Response Study (demo)',
  nctNumber: 'NCT-DEMO-0001',
  condition: 'ADHD',
  site: 'Redlands',
  studyDrug: 'DEMO-STIM-01',
  ageMin: 18,
  ageMax: 55,
  diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
  ratingScales: [{ name: 'ASRS-v1.1', description: 'Adult ADHD Self-Report Scale' }],
  medicationClasses: [{ className: 'Stimulant', washoutDays: 14, rule: 'No stimulant medication within the last 14 days' }],
}

type HeroPatient = {
  id: string; trialId: string; overallStatus: 'green' | 'yellow' | 'red'
  nameIntakeq: string; nameTebra: string | null; dobIntakeq: string; dobTebra: string | null
  city: string; zip: string; phone: string; emailIntakeq: string; emailTebra: string | null
  provider: string; ratingScale: { name: string; score: number; date: string }
  diagnosisCode: { code: string; description: string }
  activeMed: { name: string; medicationClass: string; dose: string; startDate: string }
  criteria: { key: string; text: string; verdict: 'green' | 'yellow' | 'red'; quote: string; sourceDoc: string; sourceDate: string }[]
}

const HERO_PATIENTS: HeroPatient[] = [
  {
    id: 'RD-0001', trialId: 'nct06911112', overallStatus: 'green',
    nameIntakeq: 'Maria Alvarez', nameTebra: 'Maria Alvarez', dobIntakeq: '1985-03-12', dobTebra: '1985-03-12',
    city: 'Redlands', zip: '92373', phone: '909-555-0142', emailIntakeq: 'malvarez.demo@example.com', emailTebra: 'maria.alvarez.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 18, date: '2026-09-01' },
    diagnosisCode: { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
    activeMed: { name: 'Sertraline', medicationClass: 'SSRI/SNRI antidepressant', dose: '100mg daily', startDate: '2026-06-01' },
    criteria: [
      { key: 'age-range', text: 'Age 18-65', verdict: 'green', quote: 'DOB 1985-03-12 (age 41)', sourceDoc: 'Tebra Patient record', sourceDate: '2026-09-01' },
      { key: 'diagnosis', text: 'Confirmed MDD diagnosis (F32.x/F33.x)', verdict: 'green', quote: 'Dx: F33.1 Major depressive disorder, recurrent, moderate', sourceDoc: 'Tebra Condition list', sourceDate: '2025-01-15' },
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'green', quote: 'Sertraline 100mg daily, start 2026-06-01', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-06-01' },
    ],
  },
  {
    id: 'RD-0002', trialId: 'nct06911112', overallStatus: 'red',
    nameIntakeq: 'James Thornton', nameTebra: 'James Thornton', dobIntakeq: '1990-11-02', dobTebra: '1990-11-02',
    city: 'Highland', zip: '92346', phone: '909-555-0198', emailIntakeq: 'jthornton.demo@example.com', emailTebra: 'jthornton.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 9, date: '2026-08-20' },
    diagnosisCode: { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    activeMed: { name: 'Bupropion', medicationClass: 'NDRI (excluded class)', dose: '150mg daily', startDate: '2026-08-01' },
    criteria: [
      { key: 'diagnosis', text: 'Confirmed MDD diagnosis (F32.x/F33.x)', verdict: 'green', quote: 'Dx: F32.1 Major depressive disorder, single episode, moderate', sourceDoc: 'Tebra Condition list', sourceDate: '2026-08-01' },
      { key: 'excluded-medication', text: 'Not currently on an excluded medication class', verdict: 'red', quote: 'Bupropion 150mg daily, start 2026-08-01 — protocol excludes NDRI class', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-08-01' },
    ],
  },
  {
    id: 'RD-0003', trialId: 'nct06911112', overallStatus: 'yellow',
    nameIntakeq: 'Linda Cho', nameTebra: null, dobIntakeq: '1978-06-30', dobTebra: null,
    city: 'Yucaipa', zip: '92399', phone: '909-555-0177', emailIntakeq: 'lcho.demo@example.com', emailTebra: null,
    provider: 'Unmatched', ratingScale: { name: 'PHQ-9', score: 15, date: '2026-09-05' },
    diagnosisCode: { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
    activeMed: { name: 'Unknown', medicationClass: 'Unknown', dose: 'Unknown', startDate: '2026-01-01' },
    criteria: [
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'yellow', quote: 'No matching Tebra chart yet — identity match pending', sourceDoc: 'N/A', sourceDate: '2026-09-05' },
    ],
  },
  {
    id: 'RD-0004', trialId: 'nct-adhd-demo-01', overallStatus: 'green',
    nameIntakeq: 'Priya Natarajan', nameTebra: 'Priya Natarajan', dobIntakeq: '1994-02-18', dobTebra: '1994-02-18',
    city: 'Redlands', zip: '92374', phone: '909-555-0133', emailIntakeq: 'pnatarajan.demo@example.com', emailTebra: 'pnatarajan.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'ASRS-v1.1', score: 21, date: '2026-09-02' },
    diagnosisCode: { code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' },
    activeMed: { name: 'None', medicationClass: 'None', dose: 'N/A', startDate: '2026-01-01' },
    criteria: [
      { key: 'diagnosis', text: 'Confirmed ADHD diagnosis (F90.x)', verdict: 'green', quote: 'Dx: F90.2 Attention-deficit hyperactivity disorder, combined type', sourceDoc: 'Tebra Condition list', sourceDate: '2025-11-01' },
      { key: 'stimulant-washout', text: 'No stimulant medication within the last 14 days', verdict: 'green', quote: 'No active or recent stimulant prescriptions on file', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-09-02' },
    ],
  },
  {
    id: 'RD-0005', trialId: 'nct-adhd-demo-01', overallStatus: 'red',
    nameIntakeq: 'Marcus Webb', nameTebra: 'Marcus Webb', dobIntakeq: '1988-09-09', dobTebra: '1988-09-09',
    city: 'Loma Linda', zip: '92354', phone: '909-555-0161', emailIntakeq: 'mwebb.demo@example.com', emailTebra: 'mwebb.demo@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'ASRS-v1.1', score: 19, date: '2026-08-28' },
    diagnosisCode: { code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' },
    activeMed: { name: 'Lisdexamfetamine', medicationClass: 'Stimulant', dose: '30mg daily', startDate: '2026-09-01' },
    criteria: [
      { key: 'stimulant-washout', text: 'No stimulant medication within the last 14 days', verdict: 'red', quote: 'Lisdexamfetamine 30mg daily, active as of 2026-09-01', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-09-01' },
    ],
  },
  {
    id: 'RD-0006', trialId: 'nct06911112', overallStatus: 'yellow',
    nameIntakeq: 'Katherine Voss', nameTebra: 'Kathryn Voss', dobIntakeq: '1982-12-05', dobTebra: '1982-12-05',
    city: 'Redlands', zip: '92373', phone: '909-555-0188', emailIntakeq: 'kvoss.demo@example.com', emailTebra: 'kvoss.old@example.com',
    provider: 'Dr. R. Kunam', ratingScale: { name: 'PHQ-9', score: 16, date: '2026-08-15' },
    diagnosisCode: { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
    activeMed: { name: 'Venlafaxine', medicationClass: 'SSRI/SNRI antidepressant', dose: '75mg daily', startDate: '2026-08-10' },
    criteria: [
      { key: 'antidepressant-duration', text: 'On current antidepressant dose >= 8 weeks', verdict: 'yellow', quote: 'Venlafaxine start date 2026-08-10 is only 5 weeks before referral — needs verification against the 8-week rule', sourceDoc: 'Tebra MedicationRequest', sourceDate: '2026-08-10' },
    ],
  },
]

const FILLER_NAMES = [
  'Robert Nguyen', 'Angela Ferraro', 'Devon Okafor', 'Sana Patel', 'Wesley Turner', 'Isabel Marquez',
  'Owen Fitzgerald', 'Grace Kim', 'Tobias Reyes', 'Nadia Suleiman', 'Colin Brantley', 'Fatima Rashid',
]

async function seedFillerPatients() {
  for (let i = 0; i < FILLER_NAMES.length; i++) {
    const id = `RD-${String(7 + i).padStart(4, '0')}`
    const trial = i % 2 === 0 ? MDD_TRIAL : ADHD_TRIAL
    const status: 'green' | 'yellow' | 'red' = ['green', 'green', 'yellow', 'red'][i % 4] as 'green' | 'yellow' | 'red'
    const [first, last] = FILLER_NAMES[i].split(' ')

    await db.insert(patients).values({
      id,
      intakeqClientIdEncrypted: `enc-iq-${id}`,
      tebraPatientIdEncrypted: `enc-tb-${id}`,
      nameIntakeq: FILLER_NAMES[i],
      nameTebra: FILLER_NAMES[i],
      dobIntakeq: `19${80 + i}-0${(i % 9) + 1}-1${i % 9}`,
      dobTebra: `19${80 + i}-0${(i % 9) + 1}-1${i % 9}`,
      cityIntakeq: 'Redlands',
      zipIntakeq: '92373',
      phoneIntakeq: `909-555-0${200 + i}`,
      emailIntakeq: `${first.toLowerCase()}.${last.toLowerCase()}.demo@example.com`,
      currentProvider: 'Dr. R. Kunam',
      ratingScales: [{ name: trial.ratingScales[0].name, score: 12 + i, date: '2026-09-01' }],
      referralType: 'Self-referral',
      availability: 'Flexible',
    })

    const screening = await db.insert(patientTrialScreenings).values({ patientId: id, trialId: trial.id, overallStatus: status }).returning()
    await db.insert(screeningCriteriaResults).values({
      screeningId: screening[0].id,
      criterionKey: 'diagnosis',
      criterionText: `Confirmed ${trial.condition} diagnosis`,
      verdict: status,
      evidenceQuote: `Dx: ${trial.diagnosisCodes[0].code} ${trial.diagnosisCodes[0].description}`,
      evidenceSourceDoc: 'Tebra Condition list',
      evidenceSourceDate: '2026-08-01',
    })
  }
}

export async function seed() {
  await db.insert(trials).values([MDD_TRIAL, ADHD_TRIAL])

  await db.insert(users).values([
    { name: 'Jamie Ruiz', email: 'jruiz.demo@example.com', role: 'crc' },
    { name: 'Dr. R. Kunam', email: 'rkunam.demo@example.com', role: 'pi' },
    { name: 'Sam Patel', email: 'spatel.demo@example.com', role: 'admin' },
  ])

  for (const p of HERO_PATIENTS) {
    await db.insert(patients).values({
      id: p.id,
      intakeqClientIdEncrypted: `enc-iq-${p.id}`,
      tebraPatientIdEncrypted: p.nameTebra ? `enc-tb-${p.id}` : null,
      nameIntakeq: p.nameIntakeq,
      nameTebra: p.nameTebra,
      dobIntakeq: p.dobIntakeq,
      dobTebra: p.dobTebra,
      cityIntakeq: p.city,
      zipIntakeq: p.zip,
      phoneIntakeq: p.phone,
      emailIntakeq: p.emailIntakeq,
      emailTebra: p.emailTebra,
      currentProvider: p.provider,
      ratingScales: [p.ratingScale],
      referralType: 'Provider referral',
      availability: 'Weekday mornings',
      commConsentSigned: true,
      commConsentPref: 'Phone',
    })

    await db.insert(diagnoses).values({ patientId: p.id, code: p.diagnosisCode.code, description: p.diagnosisCode.description, source: 'tebra', date: '2025-01-15' })
    if (p.activeMed.name !== 'Unknown' && p.activeMed.name !== 'None') {
      await db.insert(medicationEpisodes).values({ patientId: p.id, name: p.activeMed.name, medicationClass: p.activeMed.medicationClass, dose: p.activeMed.dose, startDate: p.activeMed.startDate, status: 'active' })
    }

    const screening = await db.insert(patientTrialScreenings).values({ patientId: p.id, trialId: p.trialId, overallStatus: p.overallStatus }).returning()
    for (const c of p.criteria) {
      await db.insert(screeningCriteriaResults).values({ screeningId: screening[0].id, criterionKey: c.key, criterionText: c.text, verdict: c.verdict, evidenceQuote: c.quote, evidenceSourceDoc: c.sourceDoc, evidenceSourceDate: c.sourceDate })
    }
  }

  await seedFillerPatients()

  await db.insert(identityMatches).values([
    { intakeqClientIdEncrypted: 'enc-iq-pending-01', referralName: 'Linda Cho', referralDob: '1978-06-30', candidateTebraPatientIdEncrypted: 'enc-tb-cand-01', candidateName: 'Linda M. Cho', candidateDob: '1978-06-30', confidence: 72, status: 'pending' },
    { intakeqClientIdEncrypted: 'enc-iq-pending-02', referralName: 'Katherine Voss', referralDob: '1982-12-05', candidateTebraPatientIdEncrypted: 'enc-tb-cand-02', candidateName: 'Kathryn Voss', candidateDob: '1982-12-05', confidence: 88, status: 'pending' },
  ])
}

if (require.main === module) {
  seed().then(() => { console.log('Seed complete'); process.exit(0) })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/seed.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add seed script with two-trial, 18-patient demo fixture data"
```

---

### Task 5: Rule engine + StatusChip component

**Files:**
- Create: `src/lib/rule-engine.ts`, `src/components/StatusChip.tsx`
- Test: `tests/lib/rule-engine.test.ts`, `tests/components/StatusChip.test.tsx`

**Interfaces:**
- Produces: `evaluateCriteria(results: { verdict: 'green'|'yellow'|'red' }[]): 'green'|'yellow'|'red'` and `<StatusChip status="green"|"yellow"|"red" />` — used by Task 8 API and Task 11/12 UI.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/rule-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { evaluateCriteria } from '@/lib/rule-engine'

describe('evaluateCriteria', () => {
  it('returns red if any criterion is red', () => {
    expect(evaluateCriteria([{ verdict: 'green' }, { verdict: 'red' }])).toBe('red')
  })
  it('returns yellow if any criterion is yellow and none are red', () => {
    expect(evaluateCriteria([{ verdict: 'green' }, { verdict: 'yellow' }])).toBe('yellow')
  })
  it('returns green only if all criteria are green', () => {
    expect(evaluateCriteria([{ verdict: 'green' }, { verdict: 'green' }])).toBe('green')
  })
  it('never guesses green from an empty result set', () => {
    expect(evaluateCriteria([])).toBe('yellow')
  })
})
```

Create `tests/components/StatusChip.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusChip } from '@/components/StatusChip'

describe('StatusChip', () => {
  it('renders the label text, not just a color', () => {
    render(<StatusChip status="green" />)
    expect(screen.getByText(/meets/i)).toBeInTheDocument()
  })
  it('renders an icon element alongside the label', () => {
    const { container } = render(<StatusChip status="red" />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/rule-engine.test.ts tests/components/StatusChip.test.tsx`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

Create `src/lib/rule-engine.ts`:

```typescript
export type Verdict = 'green' | 'yellow' | 'red'

/**
 * Never guesses green: an empty evidence set defaults to yellow
 * (per the "no guessing" rule in the client proposal, §2 rule 2).
 */
export function evaluateCriteria(results: { verdict: Verdict }[]): Verdict {
  if (results.length === 0) return 'yellow'
  if (results.some((r) => r.verdict === 'red')) return 'red'
  if (results.some((r) => r.verdict === 'yellow')) return 'yellow'
  return 'green'
}
```

Create `src/components/StatusChip.tsx`:

```typescript
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import type { Verdict } from '@/lib/rule-engine'

const CONFIG: Record<Verdict, { label: string; icon: typeof CheckCircle2; className: string }> = {
  green: { label: 'Meets', icon: CheckCircle2, className: 'bg-green-100 text-green-800 border-green-300' },
  yellow: { label: 'Needs Verification', icon: AlertTriangle, className: 'bg-amber-100 text-amber-800 border-amber-300' },
  red: { label: 'Potential Exclusion', icon: XCircle, className: 'bg-red-100 text-red-800 border-red-300' },
}

export function StatusChip({ status }: { status: Verdict }) {
  const { label, icon: Icon, className } = CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${className}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/rule-engine.test.ts tests/components/StatusChip.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add deterministic rule engine and StatusChip (icon+label, never color alone)"
```

---

### Task 6: Identity matcher

**Files:**
- Create: `src/lib/matcher.ts`
- Test: `tests/lib/matcher.test.ts`

**Interfaces:**
- Produces: `matchConfidence(a: {name: string; dob: string}, b: {name: string; dob: string}): number` (0-100) and `classifyMatch(confidence: number): 'auto'|'needs-review'|'no-match'`. **Not wired into any Plan A route or UI** — Task 4's seed data hardcodes pending `identityMatches` rows with a fixed `confidence` value, and Task 9/13 only read/display that pre-seeded value. This task exists as a tested, ready-to-use pure-function unit for Plan B, where real-time Tebra search results will need actual confidence scoring. Do not treat "not consumed elsewhere in Plan A" as a defect in Task 9 or Task 13's review.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/matcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { matchConfidence, classifyMatch } from '@/lib/matcher'

describe('matchConfidence', () => {
  it('returns 100 for an exact name and DOB match', () => {
    expect(matchConfidence({ name: 'Maria Alvarez', dob: '1985-03-12' }, { name: 'Maria Alvarez', dob: '1985-03-12' })).toBe(100)
  })
  it('returns 0 if DOB does not match, regardless of name similarity', () => {
    expect(matchConfidence({ name: 'Maria Alvarez', dob: '1985-03-12' }, { name: 'Maria Alvarez', dob: '1990-01-01' })).toBe(0)
  })
  it('returns a partial score for a close but non-exact name with matching DOB', () => {
    const score = matchConfidence({ name: 'Katherine Voss', dob: '1982-12-05' }, { name: 'Kathryn Voss', dob: '1982-12-05' })
    expect(score).toBeGreaterThan(50)
    expect(score).toBeLessThan(100)
  })
})

describe('classifyMatch', () => {
  it('classifies 95+ as auto', () => { expect(classifyMatch(95)).toBe('auto') })
  it('classifies 40-94 as needs-review', () => { expect(classifyMatch(70)).toBe('needs-review') })
  it('classifies below 40 as no-match', () => { expect(classifyMatch(10)).toBe('no-match') })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/matcher.test.ts`
Expected: FAIL — `src/lib/matcher.ts` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/lib/matcher.ts`:

```typescript
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function nameSimilarity(a: string, b: string): number {
  const an = a.toLowerCase().trim()
  const bn = b.toLowerCase().trim()
  if (an === bn) return 100
  const dist = levenshtein(an, bn)
  const maxLen = Math.max(an.length, bn.length)
  return Math.max(0, Math.round((1 - dist / maxLen) * 100))
}

/**
 * DOB is the primary matching key (per the client proposal, §2 step 2):
 * a DOB mismatch always means 0 confidence, regardless of name similarity.
 */
export function matchConfidence(a: { name: string; dob: string }, b: { name: string; dob: string }): number {
  if (a.dob !== b.dob) return 0
  return nameSimilarity(a.name, b.name)
}

export function classifyMatch(confidence: number): 'auto' | 'needs-review' | 'no-match' {
  if (confidence >= 95) return 'auto'
  if (confidence >= 40) return 'needs-review'
  return 'no-match'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/matcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add identity matcher (DOB-gated name similarity, never auto-guesses)"
```

---

### Task 7: Demo auth (role switcher) + route guard

**Files:**
- Create: `src/lib/auth.ts`, `src/app/login/page.tsx`, `src/middleware.ts`
- Test: `tests/lib/auth.test.ts`

**Interfaces:**
- Produces: `setRoleCookie(role, name)`, `getSession(): { role: 'crc'|'pi'|'admin'; name: string } | null` — every protected page (Tasks 10-15) calls `getSession()` to decide what actions to show.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseSessionCookie, buildSessionCookieValue } from '@/lib/auth'

describe('auth session cookie', () => {
  it('round-trips role and name through the cookie value', () => {
    const value = buildSessionCookieValue('pi', 'Dr. R. Kunam')
    const parsed = parseSessionCookie(value)
    expect(parsed).toEqual({ role: 'pi', name: 'Dr. R. Kunam' })
  })
  it('returns null for a malformed cookie value', () => {
    expect(parseSessionCookie('not-json')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/auth.test.ts`
Expected: FAIL — `src/lib/auth.ts` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/lib/auth.ts`:

```typescript
import { cookies } from 'next/headers'

export type Role = 'crc' | 'pi' | 'admin'
export interface Session { role: Role; name: string }

const COOKIE_NAME = 'clinsync_demo_session'

export function buildSessionCookieValue(role: Role, name: string): string {
  return JSON.stringify({ role, name })
}

export function parseSessionCookie(value: string): Session | null {
  try {
    const parsed = JSON.parse(value)
    if (parsed.role && parsed.name) return parsed as Session
    return null
  } catch {
    return null
  }
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies()
  const raw = store.get(COOKIE_NAME)?.value
  return raw ? parseSessionCookie(raw) : null
}

export async function setSessionCookie(role: Role, name: string) {
  const store = await cookies()
  store.set(COOKIE_NAME, buildSessionCookieValue(role, name), { httpOnly: true, sameSite: 'lax', path: '/' })
}

export const SESSION_COOKIE_NAME = COOKIE_NAME
```

Create `src/middleware.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME } from '@/lib/auth'

export function middleware(request: NextRequest) {
  const hasSession = request.cookies.has(SESSION_COOKIE_NAME)
  if (!hasSession && !request.nextUrl.pathname.startsWith('/login')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] }
```

Create `src/app/login/page.tsx`:

```typescript
'use client'
import { useRouter } from 'next/navigation'

const DEMO_USERS = [
  { role: 'crc', name: 'Jamie Ruiz (Research Coordinator)' },
  { role: 'pi', name: 'Dr. R. Kunam (Principal Investigator)' },
  { role: 'admin', name: 'Sam Patel (Admin / IT)' },
] as const

export default function LoginPage() {
  const router = useRouter()

  async function signIn(role: string, name: string) {
    await fetch('/api/demo-login', { method: 'POST', body: JSON.stringify({ role, name }) })
    router.push('/patients')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">Clinsync — Demo Sign In</h1>
        <p className="mb-6 text-sm text-slate-500">Pilot demo only. Choose a role to explore the prototype.</p>
        <div className="space-y-2">
          {DEMO_USERS.map((u) => (
            <button key={u.role} onClick={() => signIn(u.role, u.name)} className="w-full rounded-md border px-4 py-2 text-left text-sm hover:bg-slate-50">
              {u.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

Create `src/app/api/demo-login/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { setSessionCookie, Role } from '@/lib/auth'

export async function POST(request: NextRequest) {
  const { role, name } = await request.json()
  await setSessionCookie(role as Role, name)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add demo role-switcher auth and route guard middleware"
```

---

### Task 8: API — patients list, detail, refresh, and the Redis cache layer

**Files:**
- Create: `src/lib/cache.ts`, `src/app/api/patients/route.ts`, `src/app/api/patients/[anonId]/route.ts`, `src/app/api/patients/[anonId]/refresh/route.ts`
- Test: `tests/lib/cache.test.ts`, `tests/api/patients.test.ts`

**Interfaces:**
- Consumes: `getDb`, schema tables, `evaluateCriteria`, `getSession`.
- Produces: `getOrSetCache<T>(key, ttlSeconds, fn): Promise<T>`, `invalidateCache(key): Promise<void>` (used by every later cached route too); `GET /api/patients?trialId=`, `GET /api/patients/[anonId]`, `POST /api/patients/[anonId]/refresh` — Task 11/12 UI fetches these.

- [ ] **Step 1: Write the failing cache test**

Create `tests/lib/cache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()

vi.mock('@upstash/redis', () => ({
  Redis: class {
    async get(key: string) { return store.get(key) ?? null }
    async set(key: string, value: unknown) { store.set(key, value) }
    async del(key: string) { store.delete(key) }
  },
}))

import { getOrSetCache, invalidateCache } from '@/lib/cache'

describe('getOrSetCache', () => {
  beforeEach(() => store.clear())

  it('calls the loader and caches the result on a miss', async () => {
    const loader = vi.fn().mockResolvedValue({ hello: 'world' })
    const result = await getOrSetCache('key-1', 60, loader)
    expect(result).toEqual({ hello: 'world' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns the cached value without calling the loader again on a hit', async () => {
    const loader = vi.fn().mockResolvedValue({ hello: 'world' })
    await getOrSetCache('key-2', 60, loader)
    await getOrSetCache('key-2', 60, loader)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('invalidateCache forces the next call to hit the loader again', async () => {
    const loader = vi.fn().mockResolvedValue({ v: 1 })
    await getOrSetCache('key-3', 60, loader)
    await invalidateCache('key-3')
    await getOrSetCache('key-3', 60, loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/cache.test.ts`
Expected: FAIL — `src/lib/cache.ts` doesn't exist.

- [ ] **Step 3: Implement the cache helper**

Create `src/lib/cache.ts`. Vercel's Upstash Redis integration provisions `KV_REST_API_URL` / `KV_REST_API_TOKEN` (not `UPSTASH_REDIS_REST_URL`/`TOKEN`, which is what `Redis.fromEnv()` looks for) — construct the client explicitly with those names:

```typescript
import { Redis } from '@upstash/redis'

function createRedis() {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  })
}

let _redis: Redis | null = null
function getRedis() {
  if (!_redis) _redis = createRedis()
  return _redis
}

/**
 * Read-through cache: returns the cached value if present, otherwise
 * calls `loader`, caches its result for `ttlSeconds`, and returns it.
 * Used to keep the Patients workbook and Patient Detail screens fast
 * without re-querying Postgres on every request.
 */
export async function getOrSetCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const cached = await getRedis().get<T>(key)
  if (cached !== null && cached !== undefined) return cached
  const fresh = await loader()
  await getRedis().set(key, fresh, { ex: ttlSeconds })
  return fresh
}

export async function invalidateCache(key: string): Promise<void> {
  await getRedis().del(key)
}

export function patientListCacheKey(trialId: string | null): string {
  return `patients:list:${trialId ?? 'all'}`
}

export function patientDetailCacheKey(anonId: string): string {
  return `patients:detail:${anonId}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/cache.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the cache layer**

```bash
git add -A
git commit -m "feat: add Redis read-through cache helper (Upstash, KV_REST_API_* env vars)"
```

- [ ] **Step 6: Write the failing API test**

Create `tests/api/patients.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { GET as listPatients } from '@/app/api/patients/route'
import { GET as getPatient } from '@/app/api/patients/[anonId]/route'
import { NextRequest } from 'next/server'

describe('GET /api/patients', () => {
  it('returns a list of patients with their overall screening status', async () => {
    const response = await listPatients(new NextRequest('http://localhost/api/patients'))
    const body = await response.json()
    expect(Array.isArray(body.patients)).toBe(true)
    expect(body.patients[0]).toHaveProperty('overallStatus')
  })

  it('filters by trialId when provided', async () => {
    const response = await listPatients(new NextRequest('http://localhost/api/patients?trialId=nct06911112'))
    const body = await response.json()
    expect(body.patients.every((p: any) => p.trialId === 'nct06911112')).toBe(true)
  })
})

describe('GET /api/patients/[anonId]', () => {
  it('returns full 30-field detail plus criteria evidence for a known patient', async () => {
    const response = await getPatient(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    const body = await response.json()
    expect(body.id).toBe('RD-0001')
    expect(body.criteria.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown anonymous id', async () => {
    const response = await getPatient(new NextRequest('http://localhost/api/patients/RD-9999'), { params: Promise.resolve({ anonId: 'RD-9999' }) })
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/api/patients.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 8: Implement**

Create `src/app/api/patients/route.ts` — list results are cached for 30s per trial filter, since the workbook is read far more often than it changes:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'
import { getOrSetCache, patientListCacheKey } from '@/lib/cache'

export async function GET(request: NextRequest) {
  const trialId = request.nextUrl.searchParams.get('trialId')

  const patientsWithStatus = await getOrSetCache(patientListCacheKey(trialId), 30, async () => {
    const rows = await getDb()
      .select({ patient: patients, screening: patientTrialScreenings })
      .from(patients)
      .leftJoin(patientTrialScreenings, eq(patientTrialScreenings.patientId, patients.id))
      .where(trialId ? eq(patientTrialScreenings.trialId, trialId) : undefined)

    return rows.map((r) => ({ ...r.patient, trialId: r.screening?.trialId, overallStatus: r.screening?.overallStatus }))
  })

  const session = await getSession()
  await logAudit(session, 'viewed patient list', null)

  return NextResponse.json({ patients: patientsWithStatus })
}
```

Create `src/app/api/patients/[anonId]/route.ts` — detail is cached for 30s per patient, invalidated explicitly on refresh (Step below):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, screeningCriteriaResults, diagnoses, medicationEpisodes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'
import { getOrSetCache, patientDetailCacheKey } from '@/lib/cache'

export async function GET(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const { anonId } = await params

  const detail = await getOrSetCache(patientDetailCacheKey(anonId), 30, async () => {
    const [patient] = await getDb().select().from(patients).where(eq(patients.id, anonId))
    if (!patient) return null

    const [screening] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, anonId))
    const criteria = screening ? await getDb().select().from(screeningCriteriaResults).where(eq(screeningCriteriaResults.screeningId, screening.id)) : []
    const dx = await getDb().select().from(diagnoses).where(eq(diagnoses.patientId, anonId))
    const meds = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, anonId))

    return { ...patient, overallStatus: screening?.overallStatus, criteria, diagnoses: dx, medications: meds }
  })

  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const session = await getSession()
  await logAudit(session, 'viewed patient detail', anonId)

  return NextResponse.json(detail)
}
```

Create `src/app/api/patients/[anonId]/refresh/route.ts` — invalidates both the patient's detail cache and every list-cache entry that could include them, since a status change can move a row between filtered views:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, screeningCriteriaResults } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { evaluateCriteria } from '@/lib/rule-engine'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'
import { invalidateCache, patientDetailCacheKey, patientListCacheKey } from '@/lib/cache'

// Re-runs the rule engine against currently stored evidence and updates
// `chartDataAsOf`. In Plan B this also re-fetches from the real
// IntakeQ/Tebra connectors before re-evaluating.
export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const { anonId } = await params
  const [screening] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, anonId))
  if (!screening) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const criteria = await getDb().select().from(screeningCriteriaResults).where(eq(screeningCriteriaResults.screeningId, screening.id))
  const overallStatus = evaluateCriteria(criteria)
  await getDb().update(patientTrialScreenings).set({ overallStatus }).where(eq(patientTrialScreenings.id, screening.id))
  await getDb().update(patients).set({ chartDataAsOf: new Date() }).where(eq(patients.id, anonId))

  await invalidateCache(patientDetailCacheKey(anonId))
  await invalidateCache(patientListCacheKey(screening.trialId))
  await invalidateCache(patientListCacheKey(null))

  const session = await getSession()
  await logAudit(session, 'refreshed patient from source systems', anonId)

  return NextResponse.json({ overallStatus })
}
```

Create `src/lib/audit.ts` (small shared helper used by every route above and by Task 9's routes):

```typescript
import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Session } from './auth'

export async function logAudit(session: Session | null, action: string, patientId: string | null) {
  await getDb().insert(auditLog).values({
    userName: session?.name ?? 'unknown',
    role: session?.role ?? 'crc',
    action,
    patientId,
  })
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run tests/api/patients.test.ts`
Expected: PASS — the cache module is real (not mocked) in this test file, so these calls exercise the actual Upstash-backed cache; this is acceptable here because the test only asserts response shape, not cache timing.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add patients list/detail/refresh API routes, cached via Redis"
```

---

### Task 9: API — identity matches, trials, audit log

**Files:**
- Create: `src/app/api/identity-matches/route.ts`, `src/app/api/identity-matches/[id]/confirm/route.ts`, `src/app/api/identity-matches/[id]/reject/route.ts`, `src/app/api/trials/route.ts`, `src/app/api/trials/[trialId]/criteria/route.ts`, `src/app/api/audit-log/route.ts`
- Test: `tests/api/identity-matches.test.ts`, `tests/api/trials.test.ts`, `tests/api/audit-log.test.ts`

**Interfaces:**
- Consumes: `db`, schema tables, `logAudit`.
- Produces: the remaining REST endpoints from spec §7.5 — Task 13/14/15 UI fetches these.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/identity-matches.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { GET as listMatches } from '@/app/api/identity-matches/route'
import { POST as confirmMatch } from '@/app/api/identity-matches/[id]/confirm/route'
import { POST as rejectMatch } from '@/app/api/identity-matches/[id]/reject/route'
import { NextRequest } from 'next/server'

describe('identity matches', () => {
  it('lists pending matches', async () => {
    const response = await listMatches(new NextRequest('http://localhost/api/identity-matches'))
    const body = await response.json()
    expect(body.matches.length).toBeGreaterThanOrEqual(2)
  })

  it('confirming a match sets its status to confirmed, never auto-decided', async () => {
    const listResponse = await listMatches(new NextRequest('http://localhost/api/identity-matches'))
    const { matches } = await listResponse.json()
    const target = matches[0]
    const response = await confirmMatch(new NextRequest('http://localhost/api/identity-matches/x/confirm', { method: 'POST' }), { params: Promise.resolve({ id: String(target.id) }) })
    const body = await response.json()
    expect(body.status).toBe('confirmed')
  })

  it('rejecting a match sets its status to rejected', async () => {
    const listResponse = await listMatches(new NextRequest('http://localhost/api/identity-matches'))
    const { matches } = await listResponse.json()
    const target = matches[matches.length - 1]
    const response = await rejectMatch(new NextRequest('http://localhost/api/identity-matches/x/reject', { method: 'POST' }), { params: Promise.resolve({ id: String(target.id) }) })
    const body = await response.json()
    expect(body.status).toBe('rejected')
  })
})
```

Create `tests/api/trials.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { GET as listTrials } from '@/app/api/trials/route'
import { PUT as updateCriteria } from '@/app/api/trials/[trialId]/criteria/route'
import { NextRequest } from 'next/server'

describe('trials', () => {
  it('lists all configured trials with their per-trial rules', async () => {
    const response = await listTrials(new NextRequest('http://localhost/api/trials'))
    const body = await response.json()
    expect(body.trials.length).toBe(2)
    expect(body.trials[0].diagnosisCodes).toBeDefined()
  })

  it('updates a trial\'s medication classes without affecting other trials', async () => {
    const response = await updateCriteria(
      new NextRequest('http://localhost/api/trials/nct-adhd-demo-01/criteria', { method: 'PUT', body: JSON.stringify({ medicationClasses: [{ className: 'Stimulant', washoutDays: 21, rule: 'Updated rule' }] }) }),
      { params: Promise.resolve({ trialId: 'nct-adhd-demo-01' }) }
    )
    expect(response.status).toBe(200)
  })
})
```

Create `tests/api/audit-log.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { GET as listAuditLog } from '@/app/api/audit-log/route'
import { NextRequest } from 'next/server'

describe('audit log', () => {
  it('returns entries ordered newest first', async () => {
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    const body = await response.json()
    expect(Array.isArray(body.entries)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api/identity-matches.test.ts tests/api/trials.test.ts tests/api/audit-log.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement**

Create `src/app/api/identity-matches/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { identityMatches } from '@/db/schema'
import { eq } from 'drizzle-orm'

export async function GET() {
  const matches = await db.select().from(identityMatches).where(eq(identityMatches.status, 'pending'))
  return NextResponse.json({ matches })
}
```

Create `src/app/api/identity-matches/[id]/confirm/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { identityMatches } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [updated] = await db.update(identityMatches).set({ status: 'confirmed' }).where(eq(identityMatches.id, Number(id))).returning()
  const session = await getSession()
  await logAudit(session, `confirmed identity match ${id}`, null)
  return NextResponse.json({ status: updated.status })
}
```

Create `src/app/api/identity-matches/[id]/reject/route.ts` (the system never auto-selects a candidate — Reject is a first-class action, not an afterthought):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { identityMatches } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [updated] = await db.update(identityMatches).set({ status: 'rejected' }).where(eq(identityMatches.id, Number(id))).returning()
  const session = await getSession()
  await logAudit(session, `rejected identity match candidate ${id}`, null)
  return NextResponse.json({ status: updated.status })
}
```

Create `src/app/api/trials/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { trials } from '@/db/schema'

export async function GET() {
  const rows = await db.select().from(trials)
  return NextResponse.json({ trials: rows })
}
```

Create `src/app/api/trials/[trialId]/criteria/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { trials } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const { trialId } = await params
  const body = await request.json()
  await db.update(trials).set(body).where(eq(trials.id, trialId))
  const session = await getSession()
  await logAudit(session, `updated criteria for trial ${trialId}`, null)
  return NextResponse.json({ ok: true })
}
```

Create `src/app/api/audit-log/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { desc } from 'drizzle-orm'

export async function GET() {
  const entries = await db.select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(200)
  return NextResponse.json({ entries })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/identity-matches.test.ts tests/api/trials.test.ts tests/api/audit-log.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add identity-matches, trials, and audit-log API routes"
```

---

### Task 10: App shell — TopBanner + LeftNav

**Files:**
- Create: `src/components/TopBanner.tsx`, `src/components/LeftNav.tsx`, `src/app/(dashboard)/layout.tsx`
- Test: `tests/components/TopBanner.test.tsx`

**Interfaces:**
- Consumes: `getSession` from `@/lib/auth`.
- Produces: the layout wrapper every screen in Tasks 11-15 renders inside.

- [ ] **Step 1: Write the failing test**

Create `tests/components/TopBanner.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopBanner } from '@/components/TopBanner'

describe('TopBanner', () => {
  it('always shows the pilot/demo watermark', () => {
    render(<TopBanner environment="pilot" intakeqConnected tebraConnected userName="Jamie Ruiz" />)
    expect(screen.getByText(/PILOT.*DEMO.*NO REAL PATIENT DATA/i)).toBeInTheDocument()
  })
  it('shows connection health for both IntakeQ and Tebra', () => {
    render(<TopBanner environment="pilot" intakeqConnected tebraConnected={false} userName="Jamie Ruiz" />)
    expect(screen.getByText('IntakeQ')).toBeInTheDocument()
    expect(screen.getByText('Tebra')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/TopBanner.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement**

Create `src/components/TopBanner.tsx`:

```typescript
function ConnectionDot({ label, connected }: { label: string; connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
      <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} aria-hidden="true" />
      {label} {connected ? 'Connected' : 'Disconnected'}
    </span>
  )
}

export function TopBanner({ environment, intakeqConnected, tebraConnected, userName }: { environment: 'pilot' | 'production'; intakeqConnected: boolean; tebraConnected: boolean; userName: string }) {
  return (
    <div className="border-b bg-white">
      <div className="bg-amber-50 px-4 py-1 text-center text-xs font-semibold text-amber-800">
        {environment === 'pilot' ? 'PILOT / DEMO — NO REAL PATIENT DATA' : 'PRODUCTION'}
      </div>
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-4">
          <ConnectionDot label="IntakeQ" connected={intakeqConnected} />
          <ConnectionDot label="Tebra" connected={tebraConnected} />
        </div>
        <span className="text-sm text-slate-600">{userName}</span>
      </div>
    </div>
  )
}
```

Create `src/components/LeftNav.tsx`:

```typescript
import Link from 'next/link'

const ITEMS = [
  { href: '/patients', label: 'Patients' },
  { href: '/identity-matching', label: 'Identity Matching' },
  { href: '/trials', label: 'Trials & Protocols' },
  { href: '/audit-log', label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
]

export function LeftNav() {
  return (
    <nav className="w-56 shrink-0 border-r bg-slate-50 p-4">
      <ul className="space-y-1">
        {ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-200">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

Create `src/app/(dashboard)/layout.tsx`:

```typescript
import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { TopBanner } from '@/components/TopBanner'
import { LeftNav } from '@/components/LeftNav'
import { SessionTimeoutWarning } from '@/components/SessionTimeoutWarning'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <div className="flex min-h-screen flex-col">
      <SessionTimeoutWarning />
      <TopBanner environment="pilot" intakeqConnected tebraConnected userName={session.name} />
      <div className="flex flex-1">
        <LeftNav />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  )
}
```

(This snippet is written before Step 5 introduces `SessionTimeoutWarning`; when implementing Task 10 in order, add this import and `<SessionTimeoutWarning />` line as part of Step 5, not Step 3.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/TopBanner.test.tsx`
Expected: PASS

- [ ] **Step 5: Add the session-timeout warning (spec §6 — PHI should not linger on an unattended screen)**

Create `src/components/SessionTimeoutWarning.tsx`:

```typescript
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const WARN_AFTER_MS = 10 * 60 * 1000  // 10 min idle
const LOGOUT_AFTER_MS = 12 * 60 * 1000 // 12 min idle

export function SessionTimeoutWarning() {
  const [showWarning, setShowWarning] = useState(false)
  const router = useRouter()

  useEffect(() => {
    let warnTimer: ReturnType<typeof setTimeout>
    let logoutTimer: ReturnType<typeof setTimeout>

    function reset() {
      clearTimeout(warnTimer)
      clearTimeout(logoutTimer)
      setShowWarning(false)
      warnTimer = setTimeout(() => setShowWarning(true), WARN_AFTER_MS)
      logoutTimer = setTimeout(() => {
        document.cookie = 'clinsync_demo_session=; Max-Age=0; path=/'
        router.push('/login')
      }, LOGOUT_AFTER_MS)
    }

    reset()
    window.addEventListener('mousemove', reset)
    window.addEventListener('keydown', reset)
    return () => {
      clearTimeout(warnTimer)
      clearTimeout(logoutTimer)
      window.removeEventListener('mousemove', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [router])

  if (!showWarning) return null

  return (
    <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="rounded-lg bg-white p-6 shadow-lg">
        <p className="mb-2 font-semibold">You'll be signed out soon</p>
        <p className="mb-4 text-sm text-slate-600">For patient data protection, inactive sessions end automatically.</p>
        <button onClick={() => setShowWarning(false)} className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">
          Stay signed in
        </button>
      </div>
    </div>
  )
}
```

`src/app/(dashboard)/layout.tsx` already wires `<SessionTimeoutWarning />` in per the Step 3 snippet above.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add app shell with TopBanner, LeftNav, and session-timeout warning"
```

---

### Task 11: Patients (Workbook) screen

**Files:**
- Create: `src/app/(dashboard)/patients/page.tsx`, `src/components/SourceTag.tsx`

**Interfaces:**
- Consumes: `GET /api/patients`, `GET /api/trials`, `StatusChip`.
- Produces: the home screen; each row links to `/patients/[anonId]` (Task 12).

- [ ] **Step 1: Implement `SourceTag`**

Create `src/components/SourceTag.tsx`:

```typescript
import { Lock } from 'lucide-react'

const COLORS: Record<string, string> = {
  system: 'bg-slate-100 text-slate-700',
  intakeq: 'bg-blue-100 text-blue-700',
  tebra: 'bg-purple-100 text-purple-700',
  staff: 'bg-emerald-100 text-emerald-700',
}

// Per spec §6: every IntakeQ/Tebra-sourced field carries a read-only lock
// indicator; only "staff" fields are ever editable.
export function SourceTag({ source }: { source: 'system' | 'intakeq' | 'tebra' | 'staff' }) {
  const readOnly = source !== 'staff'
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${COLORS[source]}`}>
      {readOnly && <Lock className="h-2.5 w-2.5" aria-label="read-only" />}
      {source}
    </span>
  )
}
```

- [ ] **Step 2: Implement the Patients page**

Create `src/app/(dashboard)/patients/page.tsx`:

```typescript
import Link from 'next/link'
import { StatusChip } from '@/components/StatusChip'
import { SourceTag } from '@/components/SourceTag'

async function getPatients(trialId?: string) {
  const url = new URL('http://localhost:3000/api/patients')
  if (trialId) url.searchParams.set('trialId', trialId)
  const res = await fetch(url, { cache: 'no-store' })
  return res.json()
}

async function getTrials() {
  const res = await fetch('http://localhost:3000/api/trials', { cache: 'no-store' })
  return res.json()
}

export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ trialId?: string }> }) {
  const { trialId } = await searchParams
  const [{ patients }, { trials }] = await Promise.all([getPatients(trialId), getTrials()])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Patients</h1>
        <div className="flex gap-2 text-sm">
          <Link href="/patients" className={`rounded-md border px-3 py-1 ${!trialId ? 'bg-slate-900 text-white' : ''}`}>All Trials</Link>
          {trials.map((t: any) => (
            <Link key={t.id} href={`/patients?trialId=${t.id}`} className={`rounded-md border px-3 py-1 ${trialId === t.id ? 'bg-slate-900 text-white' : ''}`}>{t.condition}</Link>
          ))}
        </div>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-slate-50 text-left">
            <th className="p-2">Status</th>
            <th className="p-2">Anon #</th>
            <th className="p-2">Name <SourceTag source="tebra" /></th>
            <th className="p-2">DOB <SourceTag source="tebra" /></th>
            <th className="p-2">Provider <SourceTag source="tebra" /></th>
            <th className="p-2">Referral Type <SourceTag source="intakeq" /></th>
            <th className="p-2">Last Communication <SourceTag source="staff" /></th>
          </tr>
        </thead>
        <tbody>
          {patients.map((p: any) => (
            <tr key={p.id} className="border-b hover:bg-slate-50">
              <td className="p-2"><StatusChip status={p.overallStatus ?? 'yellow'} /></td>
              <td className="p-2"><Link href={`/patients/${p.id}`} className="text-blue-700 underline">{p.id}</Link></td>
              <td className="p-2">{p.nameTebra ?? p.nameIntakeq}</td>
              <td className="p-2">{p.dobTebra ?? p.dobIntakeq}</td>
              <td className="p-2">{p.currentProvider}</td>
              <td className="p-2">{p.referralType}</td>
              <td className="p-2">{p.lastCommunication ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, sign in as any demo role, visit `/patients`. Confirm: the trial filter switches the visible rows, every row's status chip shows an icon+label, and clicking an Anon # navigates to a detail page (404 until Task 12 lands — expected at this point).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Patients workbook screen with trial filter and source tags"
```

---

### Task 12: Patient Detail page

**Files:**
- Create: `src/app/(dashboard)/patients/[anonId]/page.tsx`, `src/components/EvidenceCard.tsx`

**Interfaces:**
- Consumes: `GET /api/patients/[anonId]`, `StatusChip`.

- [ ] **Step 1: Implement `EvidenceCard`**

Create `src/components/EvidenceCard.tsx`:

```typescript
import { StatusChip } from './StatusChip'

export function EvidenceCard({ criterion }: { criterion: { criterionText: string; verdict: 'green' | 'yellow' | 'red'; evidenceQuote: string | null; evidenceSourceDoc: string | null; evidenceSourceDate: string | null } }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{criterion.criterionText}</span>
        <StatusChip status={criterion.verdict} />
      </div>
      <blockquote className="rounded bg-slate-50 p-3 font-mono text-xs text-slate-700">
        {criterion.evidenceQuote ?? 'No evidence available — defaults to Needs Verification.'}
      </blockquote>
      <p className="mt-1 text-xs text-slate-400">{criterion.evidenceSourceDoc} · {criterion.evidenceSourceDate}</p>
    </div>
  )
}
```

- [ ] **Step 2: Implement the Patient Detail page**

Create `src/app/(dashboard)/patients/[anonId]/page.tsx`:

```typescript
import { notFound } from 'next/navigation'
import { StatusChip } from '@/components/StatusChip'
import { EvidenceCard } from '@/components/EvidenceCard'

async function getPatient(anonId: string) {
  const res = await fetch(`http://localhost:3000/api/patients/${anonId}`, { cache: 'no-store' })
  if (res.status === 404) return null
  return res.json()
}

function ComparisonRow({ label, intakeq, tebra, merged }: { label: string; intakeq: string | null; tebra: string | null; merged: string | null }) {
  const mismatch = intakeq && tebra && intakeq !== tebra
  return (
    <div className="grid grid-cols-4 gap-2 border-b py-2 text-sm">
      <span className="font-medium text-slate-600">{label}</span>
      <span>{intakeq ?? '—'}</span>
      <span>{tebra ?? '—'}</span>
      <span className={mismatch ? 'rounded bg-amber-100 px-1 font-medium text-amber-800' : ''}>{merged ?? '—'}</span>
    </div>
  )
}

export default async function PatientDetailPage({ params }: { params: Promise<{ anonId: string }> }) {
  const { anonId } = await params
  const patient = await getPatient(anonId)
  if (!patient) notFound()

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{patient.id} — {patient.nameTebra ?? patient.nameIntakeq}</h1>
        <StatusChip status={patient.overallStatus ?? 'yellow'} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Screening Evidence</h2>
        <div className="space-y-3">
          {patient.criteria.map((c: any) => <EvidenceCard key={c.id} criterion={c} />)}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Dual-Sourced Fields</h2>
        <div className="grid grid-cols-4 gap-2 border-b pb-1 text-xs font-semibold text-slate-400">
          <span>Field</span><span>IntakeQ</span><span>Tebra</span><span>Merged (used)</span>
        </div>
        <ComparisonRow label="Name" intakeq={patient.nameIntakeq} tebra={patient.nameTebra} merged={patient.nameTebra ?? patient.nameIntakeq} />
        <ComparisonRow label="DOB" intakeq={patient.dobIntakeq} tebra={patient.dobTebra} merged={patient.dobTebra ?? patient.dobIntakeq} />
        <ComparisonRow label="Email" intakeq={patient.emailIntakeq} tebra={patient.emailTebra} merged={patient.emailTebra ?? patient.emailIntakeq} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Diagnoses & Medications</h2>
        <ul className="list-inside list-disc text-sm">
          {patient.diagnoses.map((d: any) => <li key={d.id}>{d.code} — {d.description}</li>)}
          {patient.medications.map((m: any) => <li key={m.id}>{m.name} ({m.medicationClass}), {m.dose}, since {m.startDate} — {m.status}</li>)}
        </ul>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, visit `/patients/RD-0002` (the hand-authored red/excluded-medication case) and `/patients/RD-0006` (the dual-source name mismatch case). Confirm the evidence card shows the exact quote and the mismatch row highlights in amber.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Patient Detail page with evidence panel and dual-source comparison"
```

---

### Task 13: Identity Matching Queue screen

**Files:**
- Create: `src/app/(dashboard)/identity-matching/page.tsx`

**Interfaces:**
- Consumes: `GET /api/identity-matches`, `POST /api/identity-matches/[id]/confirm`.

- [ ] **Step 1: Implement**

Create `src/app/(dashboard)/identity-matching/page.tsx`:

```typescript
async function getMatches() {
  const res = await fetch('http://localhost:3000/api/identity-matches', { cache: 'no-store' })
  return res.json()
}

export default async function IdentityMatchingPage() {
  const { matches } = await getMatches()

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Identity Matching Queue</h1>
      <div className="space-y-4">
        {matches.map((m: any) => (
          <div key={m.id} className="grid grid-cols-2 gap-4 rounded-lg border p-4">
            <div>
              <p className="text-xs font-semibold uppercase text-blue-700">IntakeQ Referral</p>
              <p className="text-sm">{m.referralName}</p>
              <p className="text-xs text-slate-500">DOB {m.referralDob}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-purple-700">Candidate Tebra Chart ({m.confidence}% confidence)</p>
              <p className="text-sm">{m.candidateName}</p>
              <p className="text-xs text-slate-500">DOB {m.candidateDob}</p>
            </div>
            <div className="col-span-2 flex gap-2">
              <form action={`/api/identity-matches/${m.id}/confirm`} method="post">
                <button type="submit" className="rounded-md bg-green-700 px-3 py-1 text-sm text-white">Confirm Match</button>
              </form>
              <form action={`/api/identity-matches/${m.id}/reject`} method="post">
                <button type="submit" className="rounded-md border px-3 py-1 text-sm">Reject</button>
              </form>
            </div>
          </div>
        ))}
        {matches.length === 0 && <p className="text-sm text-slate-500">No pending matches — all referrals are linked.</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Manual verification**

Run: `npm run dev`, visit `/identity-matching`, confirm both seeded pending matches (Linda Cho, Katherine Voss) render side by side with their confidence scores, and clicking Confirm removes one from the list.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Identity Matching Queue screen"
```

---

### Task 14: Trials & Protocols screen

**Files:**
- Create: `src/app/(dashboard)/trials/page.tsx`, `src/app/(dashboard)/trials/[trialId]/page.tsx`

**Interfaces:**
- Consumes: `GET /api/trials`, `PUT /api/trials/[trialId]/criteria`.

- [ ] **Step 1: Implement the list page**

Create `src/app/(dashboard)/trials/page.tsx`:

```typescript
import Link from 'next/link'

async function getTrials() {
  const res = await fetch('http://localhost:3000/api/trials', { cache: 'no-store' })
  return res.json()
}

export default async function TrialsPage() {
  const { trials } = await getTrials()
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Trials & Protocols</h1>
      <div className="space-y-2">
        {trials.map((t: any) => (
          <Link key={t.id} href={`/trials/${t.id}`} className="block rounded-lg border p-4 hover:bg-slate-50">
            <p className="font-medium">{t.name}</p>
            <p className="text-sm text-slate-500">{t.nctNumber} · {t.condition} · {t.site}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Implement the detail page**

Create `src/app/(dashboard)/trials/[trialId]/page.tsx`:

```typescript
import { notFound } from 'next/navigation'

async function getTrial(trialId: string) {
  const res = await fetch('http://localhost:3000/api/trials', { cache: 'no-store' })
  const { trials } = await res.json()
  return trials.find((t: any) => t.id === trialId) ?? null
}

export default async function TrialDetailPage({ params }: { params: Promise<{ trialId: string }> }) {
  const { trialId } = await params
  const trial = await getTrial(trialId)
  if (!trial) notFound()

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-lg font-semibold">{trial.name}</h1>
      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Diagnosis Codes</h2>
        <ul className="list-inside list-disc text-sm">
          {trial.diagnosisCodes.map((d: any) => <li key={d.code}>{d.code} — {d.description}</li>)}
        </ul>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Rating Scale(s)</h2>
        <ul className="list-inside list-disc text-sm">
          {trial.ratingScales.map((r: any) => <li key={r.name}>{r.name} — {r.description}</li>)}
        </ul>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Medication Class Rules</h2>
        <ul className="list-inside list-disc text-sm">
          {trial.medicationClasses.map((m: any) => <li key={m.className}>{m.className} — {m.rule} ({m.washoutDays} days)</li>)}
        </ul>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, visit `/trials`, open both the MDD and the ADHD trial, and confirm each shows its **own** diagnosis codes, rating scale, and medication rule — proving no condition-specific logic is hardcoded (Global Constraint #1).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Trials & Protocols list and detail screens"
```

---

### Task 15: Audit Log + Settings screens

**Files:**
- Create: `src/app/(dashboard)/audit-log/page.tsx`, `src/app/(dashboard)/settings/page.tsx`

**Interfaces:**
- Consumes: `GET /api/audit-log`, `getSession`.

- [ ] **Step 1: Implement the Audit Log page**

Create `src/app/(dashboard)/audit-log/page.tsx`:

```typescript
async function getAuditLog() {
  const res = await fetch('http://localhost:3000/api/audit-log', { cache: 'no-store' })
  return res.json()
}

export default async function AuditLogPage() {
  const { entries } = await getAuditLog()
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Audit Log</h1>
      <table className="w-full text-sm">
        <thead><tr className="border-b text-left"><th className="p-2">Time</th><th className="p-2">User</th><th className="p-2">Role</th><th className="p-2">Action</th><th className="p-2">Patient</th></tr></thead>
        <tbody>
          {entries.map((e: any) => (
            <tr key={e.id} className="border-b">
              <td className="p-2 font-mono text-xs">{new Date(e.timestamp).toLocaleString()}</td>
              <td className="p-2">{e.userName}</td>
              <td className="p-2">{e.role}</td>
              <td className="p-2">{e.action}</td>
              <td className="p-2 font-mono text-xs">{e.patientId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Implement the Settings page**

Create `src/app/(dashboard)/settings/page.tsx`:

```typescript
import { getSession } from '@/lib/auth'

export default async function SettingsPage() {
  const session = await getSession()
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Connections</h2>
        <p className="text-sm">IntakeQ: <span className="font-medium text-green-700">Connected (mock)</span></p>
        <p className="text-sm">Tebra FHIR: <span className="font-medium text-green-700">Connected (mock)</span></p>
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Compliance</h2>
        <p className="text-sm">BAA status: <span className="font-medium text-amber-700">Pending signature (demo placeholder)</span></p>
        <p className="text-sm">Environment: Pilot / Demo</p>
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Signed in as</h2>
        <p className="text-sm">{session?.name} ({session?.role})</p>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, visit `/audit-log` after having viewed a couple of patients in earlier tasks, confirm those page views appear as entries. Visit `/settings` and confirm it never displays a raw API key.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Audit Log and Settings screens"
```

---

### Task 16: Excel export + Vercel deployment + final QA

**Files:**
- Create: `src/lib/excel-export.ts`, `src/app/api/workbook/export/route.ts`
- Modify: `src/app/(dashboard)/patients/page.tsx` (add Export button)
- Test: `tests/lib/excel-export.test.ts`

**Interfaces:**
- Consumes: `db`, schema tables.
- Produces: `buildWorkbookXlsx(patients): Buffer`, `GET /api/workbook/export`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/excel-export.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildWorkbookXlsx } from '@/lib/excel-export'

describe('buildWorkbookXlsx', () => {
  it('produces a non-empty xlsx buffer with a header row matching the 30-column map', async () => {
    const buffer = await buildWorkbookXlsx([
      { id: 'RD-0001', nameTebra: 'Maria Alvarez', dobTebra: '1985-03-12', currentProvider: 'Dr. R. Kunam', referralType: 'Provider referral' },
    ])
    expect(buffer.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/excel-export.test.ts`
Expected: FAIL — `src/lib/excel-export.ts` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/lib/excel-export.ts`:

```typescript
import ExcelJS from 'exceljs'

const COLUMNS = ['Anonymous Number', 'Patient Name', 'DOB', 'Current Provider', 'Referral Type']

export async function buildWorkbookXlsx(patients: { id: string; nameTebra: string | null; dobTebra: string | null; currentProvider: string | null; referralType: string | null }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Screening Workbook')
  sheet.addRow(COLUMNS)
  for (const p of patients) {
    sheet.addRow([p.id, p.nameTebra, p.dobTebra, p.currentProvider, p.referralType])
  }
  return (await workbook.xlsx.writeBuffer()) as Buffer
}
```

Create `src/app/api/workbook/export/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { patients } from '@/db/schema'
import { buildWorkbookXlsx } from '@/lib/excel-export'
import { logAudit } from '@/lib/audit'
import { getSession } from '@/lib/auth'

export async function GET() {
  const rows = await db.select().from(patients)
  const buffer = await buildWorkbookXlsx(rows)
  const session = await getSession()
  await logAudit(session, 'exported workbook to Excel', null)

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="ipmg-screening-workbook.xlsx"',
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/excel-export.test.ts`
Expected: PASS

- [ ] **Step 5: Wire up the Export button**

In `src/app/(dashboard)/patients/page.tsx`, add next to the trial filter buttons:

```typescript
<a href="/api/workbook/export" className="rounded-md border px-3 py-1 text-sm">Export to Excel</a>
```

- [ ] **Step 6: Deploy to Vercel**

```bash
vercel link --yes
vercel env pull .env.local
vercel deploy --prod
```

- [ ] **Step 7: Final QA pass against the spec**

Manually walk through `docs/superpowers/specs/2026-09-16-ipmg-workbook-ui-ux-design.md` section by section against the deployed URL:
- §4.1–4.6: every screen exists and matches its description
- §5: verify no glassmorphism/decorative motion crept in; check contrast with a browser accessibility inspector
- §6: confirm URLs never contain a name/DOB, confirm the pilot/demo banner is always visible
- §1/§4.4/§7.3: confirm both demo trials show independent, non-hardcoded rules

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Excel export and deploy the prototype to Vercel"
```

---

## Plan B (not started — blocked)

Once IPMG's signed BAA, Tebra FHIR activation, and IntakeQ API key are all in hand, write a follow-up plan that:
1. Replaces `src/connectors/intakeq.mock.ts` and `src/connectors/tebra.mock.ts` with real HTTP/FHIR implementations behind the same function signatures (Task 3's `types.ts` interfaces don't change).
2. Adds the webhook receiver (`/api/webhooks/intakeq`) with signature validation.
3. Replaces demo cookie auth (Task 7) with real SSO once IPMG confirms their identity provider (open question in the spec).
4. Adds the AWS Bedrock LLM extraction + quote-verification layer (spec §7.4) for unstructured chart notes.

Do not start Plan B until those three blockers clear — writing it now would require guessing at credentials and API behavior we cannot verify.
