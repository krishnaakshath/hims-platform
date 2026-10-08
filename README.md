# HIMS: white-label hospital information management

HIMS is a practice- and hospital-operations platform with a built-in
clinical pre-screening workbench, built by Symbiosys Technologies. It is
**white-label**: one codebase serves many clients. Each client is its own
deployment with its own database, secrets and branding, so no client's data,
name or logo ever appears in another's.

All patient data in this repository is fictional, seeded from
`src/db/seed.ts`. No real patient data is used anywhere in it.

## What it does

HIMS covers the day-to-day running of a clinic or hospital in one place:

- **Patient chart and registration**: demographics, identity verification,
  diagnoses, medications, allergies, notes, care plans, and FHIR/C-CDA exports.
- **Front desk**: registration, check-in, rooming, doctor and room
  assignment, insurance-eligibility checks, queue display.
- **Scheduling and telemedicine**: provider calendars, appointments, public
  booking requests, and video visits.
- **Inpatient**: beds and wards, inpatient medication administration, discharge.
- **Pharmacy and labs**: a dispensing counter and inventory; a lab worklist
  with collection, results, imaging and an electronic lab-results webhook.
- **Billing**: charges, claims, collections, statements, A/R and analytics.
- **Pre-screening**: a rule engine screens each patient against a trial's
  criteria and marks every criterion Meets, Needs Verification or Potential
  Exclusion, backed by the exact chart quote. See **Pre-screening** below.
- **Communication**: staff/patient messaging, broadcasts, experience surveys,
  intake forms and consent documents.
- **Patient portal**: patients see their forms, medications, appointments and
  messages, with their own sign-in.
- **Governance**: role-based access on every page and route, mandatory MFA,
  and a full audit trail.

### Pre-screening

A rule engine screens each patient against a trial's criteria. For criteria
that positively require evidence (a diagnosis match, a rating-scale
threshold), it never invents a "meets" verdict from absent evidence: no
matching chart data defaults to "needs verification". For exclusion-type
criteria and the age check, the absence of disqualifying evidence is itself a
positive finding, so those resolve to green or red directly. Either way the
verdict names the exact evidence it rests on, and humans (coordinators, then
the investigator) always make the actual eligibility call; the app only
proposes. Trial criteria are **data on the `trials` table, not code** (see
the JSONB columns in `src/db/schema.ts`), so a new trial is a new row, never
a new code path. Connectors to a practice's existing intake/forms system and
EHR are mocked today (`src/connectors/*.mock.ts`).

## Roles and sign-in

Staff share one login flow at `/login` and one session cookie (`<BRAND_COOKIE_PREFIX>_session`) — only one
staff identity can be active per browser at a time. There are seven staff
roles (`ALL_ROLES` in `src/lib/role-policy.ts`; what each one may do, in
plain language, is in `src/lib/role-capabilities.ts` and on each user's
Settings page):

- **admin** — everything a coordinator can do, plus practice
  configuration, staff and portal-credential management, and the audit log
- **coordinator (crc)** — pre-screening, forms, scheduling, billing,
  reports, and practice operations
- **principal investigator (pi)** — the clinical view: their own patient
  panel ("My Patients"), screening evidence, charts, notes, orders, and
  their own video visits
- **front desk (frontdesk)** — registration, check-in, rooming, scheduling,
  and document intake; never the clinical evidence
- **pharmacy** — the dispensing counter and its own patient lookup
- **billing** — charges, claims, collections, and insurance eligibility; no
  clinical access
- **labs** — the lab worklist (collection, results, imaging); no chart
  access

Google sign-in is optional: when `GOOGLE_CLIENT_ID` is unset its start and
callback routes answer 503 with a plain "not configured" message.

Patients sign in separately at `/patient-portal/login` with their email
address or patient ID and a portal password issued by staff. An email
shared by more than one patient is rejected with the same generic error as
a wrong password (the portal never guesses which patient was meant). That
session uses a completely distinct cookie and can never be reinterpreted
as a staff session (see `src/lib/auth.ts` vs. `src/lib/patient-session.ts`).

Every page and every read and write is role-checked server-side, not just
hidden in the UI — see **Role access matrix** under **Security model**.

## Screens

**Workspace**
- **Home** — role-specific dashboard (Admin, Coordinator, or Principal
  Investigator's "My Patients") with real-time stats, a patients-by-month
  chart, a screening-status breakdown, and the day's appointments.
- **Patients** — the main workbook: every patient, their overall status,
  inclusion/exclusion criteria met, and a trial filter.
- **Patient Detail** — screening evidence per criterion, identity
  verification status, form-vs-chart discrepancies, and patient portal
  access management (front desk sees a reduced registration view without
  any screening evidence); a dedicated **Medical Record** page holds the
  demographic fields, diagnoses, medications, allergies, notes, and the
  FHIR/C-CDA exports.
- **Workbook** — the exportable Excel pre-screening workbook.
- **Identity Matching** — a queue for reconciling referrals that couldn't
  be automatically matched to a chart.
- **Trials & Protocols** — each trial's inclusion/exclusion configuration,
  plus a live breakdown of every patient screened against it (passed,
  needs verification, or rejected, with the specific evidence why).
- **Calendar** — the day's appointments per provider.
- **Form Templates** — a question editor for intake forms, including
  answer options for choice-type questions.
- **Client Forms** — every intake form sent to a patient, its completion
  status, and a readable view of the submitted answers (open to both PI
  and coordinator sessions).
- **Messages** — a per-patient thread for staff to message a patient
  directly; mirrored in the patient's own portal.
- **Audit Log** (admin only) — every recorded staff and patient-portal
  action across the app, for HIPAA-facing PHI-access monitoring.

**Billing** — charges, insurance collections, patient collections,
statements, an A/R dashboard, analytics, and a simulated virtual-card
payment demo (no real payment processing).

**Operations** — cross-cutting reports (patients, appointments,
encounters, insurance collections, unsigned notes), document/fax intake
with processing status, patient broadcasts (simulated SMS/email, never
sent to a real patient), post-screening experience surveys, a pipeline
performance dashboard, and Settings (practice info, EHR/intake-system
connection credentials, auto-classification toggle, provider roster, and a
role-capability summary on each user's own account).

**Patient Portal** (`/patient-portal`) — a separate, patient-facing
surface with its own sidebar: overview, forms to complete, medications,
appointments, and messages with the care team.

## Compliance posture (India)

HIMS is built to be deployed for Indian clients, but **it is not certified
against any scheme, and this section is a map of what the software does, not
a legal opinion**. Each client (the data fiduciary) remains responsible for
its own policies, consent wording and registrations.

What the software provides that supports compliance with the Digital
Personal Data Protection Act, 2023 and the IT Act's reasonable-security
expectations:

- **Access control and least privilege**: server-side role checks on every
  page and API route (see **Role access matrix** below), including a front-desk view that hides
  clinical evidence.
- **Accountability**: every staff and patient-portal read/write is recorded
  in an audit log that admins can review (`/audit-log`).
- **Authentication**: TOTP MFA for staff and patients (the demo-only
  `DISABLE_STAFF_MFA` toggle must never be set for a real client); signed
  session cookies; rate-limited login that fails closed.
- **Protection of identifiers**: government ID numbers are encrypted at rest
  with AES-256-GCM (`IDENTITY_ENCRYPTION_KEY`); passwords are scrypt-hashed;
  the Excel export neutralises formula injection.
- **Isolation and residency**: one database, cache and file store per client,
  so a client can pick an Indian region for its Postgres, Redis and Vercel
  project to meet data-localisation expectations.
- **Consent and notices**: consent documents and a patient-portal terms and
  privacy flow exist, but the seeded text is a **draft, not reviewed by legal
  counsel**. Replace it before real patients rely on it.

Not provided today: ABDM/ABHA integration, a data-principal erasure or
data-export workflow, retention schedules, breach-notification tooling, and
any third-party audit or certification. Plan for those separately.


## Security model

- `requireSession()` / `requireSessionOrRedirect()` (`src/lib/auth.ts`)
  gate every staff API route and dashboard page; `requirePatientSession()`
  / `requirePatientSessionOrRedirect()` (`src/lib/patient-session.ts`) do
  the same for the patient portal, on a separate cookie and a JWT that
  carries a `kind: 'patient'` claim so it can never be reinterpreted as a
  staff session even though both share the same signing secret.
- `src/proxy.ts` validates the session **cookie's contents**, not just its
  presence, and redirects before a protected page's React tree ever
  streams — the primary defense against a PHI leak on an invalid/expired
  session.
- Server Components call shared query functions in `src/lib/queries/*.ts`
  directly. They **never** `fetch()` the app's own API routes — doing so
  once relied on a client-controlled `Host` header to build the fetch URL,
  a real, since-fixed session-cookie-exfiltration vector.
- Every read and write is attributed and logged via `src/lib/audit.ts`
  (staff) or `src/lib/patient-portal-audit.ts` (patients and the LIS
  integration) — audit entries carry a real, non-null session, never a
  fallback role, except the two token/patient-authenticated writers (the
  patient portal and the LIS integration). Admin can
  review the full log at `/audit-log`. Two narrow reads are not yet
  audited: insurance-card image fetches
  (`/api/patients/[anonId]/insurance-card/[side]`) and the billing
  primary-payer lookup (`/api/patients/[anonId]/primary-payer`, which
  returns only a payer id).
- Request bodies are validated against a strict Zod allowlist on every
  write route — no mass-assignment from raw JSON.
- TOTP-based multi-factor authentication is mandatory for every staff and
  patient-portal account (`src/lib/mfa.ts`).
- Login is rate-limited per IP and, for the patient portal, also on an
  IP-independent global bucket keyed on the normalized login identifier
  (`src/lib/rate-limit.ts`). The rate limiters (and the OTP/MFA attempt
  counters) fail **closed**: if Redis is unreachable those requests error
  rather than skip the brute-force check. The read-through data cache
  (`src/lib/cache.ts`) is the opposite — it fails **open**: a Redis error
  or timeout is logged and treated as a cache miss, so the page loads
  straight from the database.
- `POST /api/webhooks/fhir-labs` (electronic lab results) accepts only the
  `LIS_INTEGRATION_TOKEN` bearer token, compared in constant time; with no
  token configured it returns 503 and accepts nothing. An accepted result
  binds to the lab order's own patient and is written atomically with its
  audit row; rejected calls are logged, never written to the database.
- The Excel export (`src/lib/excel-export.ts`) sanitizes every cell
  against formula injection (`=`, `+`, `-`, `@` leading characters).

### Role access matrix

Every dashboard page checks the role right after
`requireSessionOrRedirect()` and redirects a denied role before any query
runs; every API route checks it right after `requireSession()` and answers
a denied role with exactly `{ "error": "Forbidden" }` (403). Each check is
an allowlist, so an unknown role is denied. Shared allowlists are named in
`src/lib/role-policy.ts` (`CLINICAL_ROLES`, `PATIENT_DIRECTORY_ROLES`,
`SCHEDULING_ROLES`, …) rather than retyped per route.

✓ = allowed, — = denied (pages redirect to the role's home, APIs 403).

| Area (pages and their APIs) | admin | crc | pi | frontdesk | pharmacy | billing | labs |
|---|---|---|---|---|---|---|---|
| Home `/` (per-role dashboard) | ✓ | ✓ | → `/doctor` | ✓ | → `/pharmacy` | → `/billing` | → `/labs` |
| My Patients `/doctor` | — | — | ✓ | — | — | — | — |
| Patients list and patient detail | ✓ | ✓ | ✓ | reduced view¹ | — | — | — |
| Medical record (chart), prescription print slip, patient JSON APIs, FHIR/C-CDA exports, discrepancy resolve | ✓ | ✓ | ✓ | — | — | — | → `/labs` |
| Identity verification (write) | ✓ | ✓ | — | ✓ | — | — | — |
| Insurance-card images (read) | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| Primary-payer lookup (billing eligibility) | ✓ | ✓ | — | — | — | ✓ | — |
| Workbook page, Trials & Protocols, Form Templates, Consent Documents, Client Forms (+ their APIs) | ✓ | ✓ | ✓ | — | — | — | — |
| Trial criteria edit | ✓ | — | ✓ | — | — | — | — |
| Calendar and appointments | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Video visits (start, rejoin link, signal, end) | ✓ | — | own only² | — | — | — | — |
| Documents (list and download) | ✓ | ✓ | ✓ | ✓ | — | — | lab-order files³ |
| Staff directory (pages and reads) | ✓ | ✓ | ✓ | — | — | — | — |
| Check-in, doctor assignments | ✓ | ✓ | — | ✓ | — | — | — |
| Beds / wards board | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Booking requests (view) | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Inpatient medications (MAR read) | ✓ | ✓ | ✓ | — | — | — | — |
| Pharmacy dashboard | ✓ | ✓ | ✓ | — | ✓ | — | — |
| Pharmacy patient lookup and pharmacy billing | ✓ | — | — | — | ✓ | — | — |
| Lab worklist `/labs` | ✓ | ✓ | ✓ | — | — | — | ✓ |
| Messages | ✓ | ✓ | ✓ | — | ✓ | — | — |
| Billing pages and charges | ✓ | ✓ | — | — | — | ✓ | — |
| Reports, Broadcasts, Experience Surveys, Pipeline Dashboard, workbook export | ✓ | ✓ | — | — | — | — | — |
| Global search | ✓ | ✓ | ✓ | patients only | — | — | — |
| Settings (writes are admin-only) | ✓ | — | ✓ | — | — | — | — |
| Audit log | ✓ | — | — | — | — | — | — |

1. Front desk sees what registration and check-in need — name, patient ID,
   date of birth, provider, identity verification, portal access, and room
   transfer — but no eligibility verdicts, criteria counts, discrepancies,
   chart summary, or discharge clinical details. The patient JSON APIs
   deny front desk; its view is rendered on the server.
2. A PI may start, recover the join link of, signal on, or end a video
   visit only on their **own** appointment, and may transfer or discharge
   only their own inpatients. The acting provider is resolved from the
   user's staff record first, then by an exact surname match that requires
   an agreeing given name (equal full names, or the same first letter when
   either side is an initial); no match or more than one match is a 403,
   never a guess. The patient joins through the tokenized public link.
3. Labs may download a document only when it is attached to a lab order
   (imaging results on the worklist); every other document is 403.

Writes are narrower than reads where the job calls for it (e.g. receiving
and filing documents is admin, crc, frontdesk; confirming booking requests
is admin, crc, frontdesk; registering a patient is admin, frontdesk;
ordering labs, prescribing, notes, and care plans are admin, pi) — each is
pinned by its route's own tests.

Two test harnesses keep this table honest across all seven roles:
`tests/pages/nav-role-enforcement.test.tsx` (with
`tests/pages/page-gates-harness.ts`) runs every `(dashboard)` page for
every role, asserts that a denied role is redirected before the database
is touched, that each page's gate agrees with the roles `LeftNav` shows it
to, and that no page file is missing from the table;
`tests/api/rbac-route-gates.test.ts` calls every role-gated API route as
every role and asserts the exact 403 body. A known-open gap can be tagged
`gap: 'Tn'` (it then runs as an expected failure; `RBAC_SHOW_GAPS=1` shows
it red), and a guard test fails while any tag remains.

## White-label a client

Every client-visible name, logo, colour, contact address and cookie or
authenticator-issuer string comes from environment variables, never from
source. With nothing set the product is the neutral "HIMS". The values are
validated (invalid ones fall back to the default and log a warning naming the
variable, never the value) and rendered as text, never as HTML.

| Variable | Purpose | Rules | Default |
|---|---|---|---|
| `BRAND_NAME` | Product name in the UI, page title, emails, SMS, print slips, authenticator app | up to 60 chars | `HIMS` |
| `BRAND_LEGAL_NAME` | Entity name on printed documents | up to 120 chars | `BRAND_NAME` |
| `BRAND_TAGLINE` | Page description / metadata | up to 160 chars | neutral default |
| `BRAND_SUPPORT_EMAIL` | Support contact | valid email | none |
| `BRAND_LOGO_URL` | Logo image | `https://` URL (no credentials) or same-origin `/path` | name as text |
| `BRAND_PRIMARY_COLOR` | Accent colour | `#rgb` or `#rrggbb` | built-in blue |
| `BRAND_COOKIE_PREFIX` | Prefix of every session cookie (`<prefix>_session`, `_patient_session`, ...) | `[a-z0-9_]{1,24}` | `hims` |

> **Brand changes require a rebuild and redeploy.** `BRAND_*` is read when the
> app is built and baked into prerendered pages, so editing the variable in
> Vercel has no effect until you redeploy.
>
> **Changing `BRAND_COOKIE_PREFIX` logs everyone out** (staff and patients),
> and abandons any in-progress MFA or Google sign-in. Pick it once per client
> and leave it.

### Per-client checklist

Every client gets its own of each of these. Never share one across clients.

1. **Postgres database**: a new, empty one (Neon or any TLS Postgres) ->
   `DATABASE_URL`.
2. **Redis**: its own Upstash Redis -> `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
3. **Blob store**: its own Vercel Blob store -> `BLOB_READ_WRITE_TOKEN`.
4. **`SESSION_SECRET`**: unique, 32+ random characters (`openssl rand -base64 48`).
5. **`IDENTITY_ENCRYPTION_KEY`**: unique 32 random bytes, base64
   (`openssl rand -base64 32`). Back it up: losing it makes encrypted ID
   numbers unreadable.
6. **SMTP and SMS**: the client's `SMTP_*` sender and, if SMS sign-in is used,
   `TWILIO_*` credentials.
7. **Domain**: the client's domain on the Vercel project, mirrored in
   `NEXT_PUBLIC_APP_URL`.
8. **Admin account**: `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD_HASH`.
9. **Branding**: the `BRAND_*` values above.

Then run `npm run db:migrate` against the new database, create the first admin, and smoke-test. The full
procedure, env var table and smoke-test list are in
[`docs/DEPLOYING.md`](docs/DEPLOYING.md). `.env.example` lists every variable
the app reads.

## Run and operate locally

```bash
npm install
cp .env.example .env.local   # then fill in values (never commit it)
npm run dev                  # http://localhost:3000, redirects to /login
npm test                     # full Vitest suite (loads .env.local via dotenv-cli; needs a database and Redis)
npm run build                # production build + typecheck
npm run db:migrate           # create/upgrade the schema of DATABASE_URL
npm run db:seed              # demo data; see below
```

`GET /api/health` reports `database`, `redis`, `migrations` and `secrets`
as fixed words (`ok`, `fail`, `not_configured`, `pending`, ...); it is the
first thing to check when sign-in fails on a new deployment.

**Demo seed.** `npm run db:seed` writes fictional patients and one demo
account per staff role at `<role>@<SEED_EMAIL_DOMAIN>` (default
`example.test`). `SEED_DEMO_PASSWORD` (12+ characters) is required and has no
default; there is no password in the source. The seed refuses to run when
`NODE_ENV` or `VERCEL_ENV` is `production` unless `ALLOW_PRODUCTION_SEED=1`.
It is safe to re-run: on an already-populated database it tops up reference
data (and issues any missing UHIDs) instead of wiping anything. The demo is an
Indian multispeciality hospital with a working day relative to today (IST);
`SEED_RESET=1` clears and rebuilds it. All identifiers are synthetic.

**Admin password hash.** `ADMIN_PASSWORD_HASH` is a `salt:hash` pair (scrypt)
matching `hashPassword()` in `src/lib/password.ts`:

```bash
node -e "const{randomBytes,scryptSync}=require('crypto');const s=randomBytes(16).toString('hex');console.log(s+':'+scryptSync(process.argv[1],s,64,{N:131072,r:8,p:1,maxmem:256*1024*1024}).toString('hex'))" "your-new-password"
```

**Patient portal passwords** are generated randomly per patient by an admin
(shown once, never stored in plaintext).

### Database changes: read before touching the schema

Every database (production, staging, a developer's local one) is built and
upgraded by one command, `npm run db:migrate`
([`scripts/db/migrate.ts`](scripts/db/migrate.ts)). On an empty database it
applies the frozen baseline (`scripts/db/baseline.sql`) and then every file in
`scripts/migrations/` in name order; afterwards it applies only the files not
yet recorded in the `schema_migrations` ledger. `npm run db:migrate:status`
shows what is applied and pending. Details: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

To change the schema:

1. Edit `src/db/schema.ts`.
2. Add `scripts/migrations/YYYY-MM-DD-<topic>.sql` with the same change,
   written to be re-runnable (`CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, guarded `DO $$ ... $$` blocks) and wrapped in
   `BEGIN; ... COMMIT;`. `ALTER TYPE ... ADD VALUE` goes in its own earlier
   file, because a new enum value cannot be used in the transaction that adds it.
3. `npm run db:migrate`, then `npm run db:schema-diff -- <your db> <a db built from empty>`
   to confirm both routes reach the same schema.

Never edit a migration file (or the baseline) once it has run anywhere:
`db:migrate` records each file's checksum and refuses to run when one changes.
**Never run `npm run db:push` or `db:generate` against a shared or real
database**: `drizzle-kit push` diffs the whole `schema.ts` against the whole
database and offers to drop what it does not know (the exclusion constraint,
the trigram index, other branches' tables). It is only for a throwaway local
database.

## Stack

Next.js 16 (App Router, TypeScript), Tailwind v4 (oklch design tokens,
`src/app/globals.css`), Drizzle ORM, Postgres (a node-postgres TCP pool,
`drizzle-orm/node-postgres`; see `src/db/client.ts`), Upstash Redis
(read-through cache, `src/lib/cache.ts`), Vercel Blob, recharts, Vitest +
Testing Library.

## Where things live

- `src/lib/brand.ts`: validated brand config (`BRAND_*`); `src/components/BrandLogo.tsx`
- `src/db/schema.ts`: source of truth for the DB schema, including the
  per-trial criteria configuration (JSONB, not code)
- `src/lib/eligibility.ts` / `src/lib/rule-engine.ts`: the verdict logic
- `src/lib/queries/*.ts`: shared data-access functions, called directly by
  both API routes and Server Component pages
- `src/app/(dashboard)/*`: the staff-facing screens
- `src/app/patient-portal/*`: the patient-facing portal
- `src/connectors/*.mock.ts`: mock connectors for the external intake/forms
  and EHR systems
- `docs/DEPLOYING.md`: deployment guide
- `docs/OPERATIONS.md`: migrations, backups and restore drills, key custody, data-safety review
- `scripts/db/`: `db:migrate` runner and frozen baseline, backup, restore drill, schema diff
- `docs/superpowers/`: historical design specs and implementation plans
