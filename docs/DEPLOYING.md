# Deploying HIMS for a client

One client = one Vercel project = one set of backing services. Do not share a
database, Redis, Blob store or secret between clients. Branding is
configuration (`BRAND_*`), so the same repository serves every client.

## 1. Provision the client's services

| Service | Provider | Gives you |
|---|---|---|
| Postgres | Neon (Vercel Marketplace) or any TLS Postgres, in the client's region | `DATABASE_URL` |
| Redis | Upstash Redis (Vercel Marketplace) | `KV_REST_API_URL`, `KV_REST_API_TOKEN` |
| Blob store | Vercel Blob, connected to the project | `BLOB_READ_WRITE_TOKEN` |
| Email | SMTP account for the client's sender address | `SMTP_*` |
| SMS (optional) | Twilio | `TWILIO_*` |

Choose regions close to the client's users (for Indian clients, an India
region where the provider offers one) for latency and data-localisation.

## 2. Create the Vercel project

1. Create a new Vercel project from this repository (framework: Next.js).
   Name it for the client, e.g. `hims-acme`.
2. Connect the client's Postgres, Redis and Blob store to that project
   (Marketplace integrations set their variables automatically).
3. Add the client's domain under Settings > Domains and set
   `NEXT_PUBLIC_APP_URL` to it (`https://...`).
4. Set the environment variables below for the **Production** environment
   (and Preview if you use it, with separate preview services; never point a
   preview at production data).

## 3. Environment variables

`.env.example` is the authoritative list; this is the same grouped by need.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Client's own Postgres. On Vercel+Neon this is the pooled URL, used by the app |
| `DATABASE_URL_UNPOOLED` | set by Neon | Direct URL; used only when running `db:migrate` / `db:backup` (not read by the app) |
| `SESSION_SECRET` | yes | Unique per client, 32+ random chars: `openssl rand -base64 48` |
| `IDENTITY_ENCRYPTION_KEY` | yes | Unique per client, 32 bytes base64: `openssl rand -base64 32`. Back it up; losing it makes encrypted ID numbers unreadable |
| `NEXT_PUBLIC_APP_URL` | yes | Public https URL of the deployment |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD_HASH` | yes | Always-available admin account. Hash generator: see README, "Admin password hash" |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes | Rate limits, MFA replay protection, cache. Rate limiters fail closed without Redis |
| `BLOB_READ_WRITE_TOKEN` | yes | Insurance cards, imaging, documents, lab report PDFs |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | yes for email codes | One-time sign-in codes by email |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | for SMS codes | |
| `BRAND_NAME`, `BRAND_LEGAL_NAME`, `BRAND_TAGLINE`, `BRAND_SUPPORT_EMAIL`, `BRAND_LOGO_URL`, `BRAND_PRIMARY_COLOR`, `BRAND_COOKIE_PREFIX` | optional | See README, "White-label a client". Read at build time |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional | Admin Google SSO; routes answer 503 when unset |
| `LIS_INTEGRATION_TOKEN` | optional | Bearer token for `/api/webhooks/fhir-labs`; unset = webhook disabled |
| `DEMO_FEATURES` | leave unset in production | `true` turns on simulated features (virtual card payment, broadcasts, experience surveys, insurance eligibility check, fax history), each labelled "Demo". Unset = off in production, on in development. When off they are hidden, their pages 404 and their routes answer 503 `Not configured` |
| `DISABLE_STAFF_MFA` | never in production | Demo toggle that skips staff MFA; ignored unless `DEMO_FEATURES` is on |
| `SEED_EMAIL_DOMAIN`, `SEED_DEMO_PASSWORD`, `ALLOW_PRODUCTION_SEED` | non-production only | See "Seeding" |

Set secrets with `vercel env add NAME production` (or the dashboard); never
commit them. Generate each client's secrets fresh.

> **Brand changes need a rebuild.** `BRAND_*` is baked in at build time. After
> editing it, redeploy (`vercel --prod`, or "Redeploy" without the build
> cache). **Changing `BRAND_COOKIE_PREFIX` signs everyone out**, so set it once
> before go-live.

## 4. Create the schema (`npm run db:migrate`)

The schema of every client database is created and upgraded by one command,
`npm run db:migrate`. It is safe to run on every deploy: it takes an advisory
lock (two runs cannot overlap), applies only what the `schema_migrations`
ledger does not already record, refuses to run if an applied file was edited,
and stops (rolling back that file) at the first error. **`db:push` is not part
of any deployment or production flow**; see "Never" below.

Step by step, for a new client:

1. **Create the database.** In the client's Vercel project: Storage > Create
   Database > **Neon** (Marketplace). Pick the region nearest the client's
   users (an India region for Indian clients) and connect it to the
   Production environment. The integration sets `DATABASE_URL` (pooled, used
   by the app) and `DATABASE_URL_UNPOOLED` (direct, used for migrations and
   backups), among others.
2. **Create Redis.** Storage > Create Database > **Upstash for Redis**
   (Marketplace), same region, connected to the project. It sets
   `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Without Redis, sign-in, MFA,
   one-time codes and the booking widget answer 503 (rate limits fail closed
   on purpose; there is no in-memory fallback).
3. **Create the Blob store** (Storage > Blob) and connect it: `BLOB_READ_WRITE_TOKEN`.
4. **Set the secrets** from section 3 (`SESSION_SECRET`,
   `IDENTITY_ENCRYPTION_KEY`, `ADMIN_*`, `NEXT_PUBLIC_APP_URL`, SMTP/SMS).
   Record `IDENTITY_ENCRYPTION_KEY` in the client's key escrow first (see
   [OPERATIONS.md](OPERATIONS.md#encryption-keys)).
5. **Run the migration** from a trusted machine with this repository checked
   out at the commit you are deploying:

   ```bash
   npm ci
   vercel link                                   # the client's project
   vercel env pull .env.production.local --environment=production
   # direct (unpooled) endpoint: the runner refuses the "-pooler" host
   npx dotenv -e .env.production.local -- sh -c 'DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:migrate:status'
   npx dotenv -e .env.production.local -- sh -c 'DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:migrate'
   rm .env.production.local                      # it holds production secrets
   ```

   On the empty database this applies `scripts/db/baseline.sql` and then
   every `scripts/migrations/*.sql` in name order, including the parts
   `schema.ts` cannot express (the `btree_gist` and `pg_trgm` extensions,
   the `tariff_rates_no_overlap` exclusion constraint, the
   `codes_display_trgm_idx` index, the billing immutability triggers).
   Run `db:migrate:status` again: every line must read `applied`.
6. **Deploy** (section 5) and check `https://<client-domain>/api/health/ready`
   answers 200 with `{"status":"ok","checks":{"database":"ok","redis":"ok","migrations":"up_to_date","secrets":"ok"}}`.
   Any other word names the missing piece; it never shows values.
7. **Create the first admin** (section 6).
8. **Code sets.** No code sets ship with the app. The owner loads the licensed
   ones (ICD-10, ICD-10-PCS, SNOMED CT, LOINC, PM-JAY HBP) with
   `npm run codes:import`; see [docs/CODE-SYSTEMS.md](CODE-SYSTEMS.md). Until a
   set is loaded, coders cannot assign codes of that kind.

**Every later release** that adds files to `scripts/migrations/`: run step 5
(`db:migrate:status`, then `db:migrate`) against production **before**
promoting the deployment, because new code may read the new columns. The
migrations are additive and idempotent, so the old deployment keeps working
on the migrated database. `/api/health` shows `"migrations":"pending"` while a
deployment's files are not all applied.

**An existing database built with `db:push`** (before the ledger existed) is
adopted on the first `db:migrate`: the baseline is recorded as already
present, every migration file is re-run (all are idempotent) and recorded.
Nothing is dropped. Take a backup first anyway (OPERATIONS.md).

**Never**:

- run `npm run db:push` (or `db:generate`) against a client, staging or shared
  database. It diffs `schema.ts` against the whole database and offers to
  drop what it does not declare: the exclusion constraint, the trigram index,
  tables of a newer release.
- edit a migration file or `scripts/db/baseline.sql` after it has been applied
  anywhere. Put the change in a new dated file; `db:migrate` refuses to run on
  a changed file and names it.
- point `db:migrate` at the pooled `-pooler` host; it refuses, because the
  advisory lock and per-file transactions need a direct connection.

## 5. Deploy

```bash
vercel --prod
```

(or push to the branch the project deploys from). Confirm the build log shows
no brand validation warnings; a warning names the invalid variable.

## 6. First admin

No staff accounts exist after migration. The admin defined by `ADMIN_EMAIL` /
`ADMIN_PASSWORD_HASH` is always available and needs no database row:

1. Sign in at `/login` as that admin and complete MFA enrolment.
2. In Settings, create the other staff accounts (admin, coordinator, PI,
   front desk, pharmacy, billing, labs). Each gets a generated password,
   shown once; hand it over securely and have the person change it.
3. Enable patient portal access per patient from the patient page (admin
   only; a random password is shown once).

## 7. Seeding (non-production only)

`npm run db:seed` loads fictional demo patients and one demo account per role
(`<role>@<SEED_EMAIL_DOMAIN>`, default `example.test`, all sharing
`SEED_DEMO_PASSWORD`). Use it for demo, staging and preview databases only:

```bash
SEED_DEMO_PASSWORD='<12+ chars>' npm run db:seed
```

- `SEED_DEMO_PASSWORD` is required; there is no default.
- The seed throws if `NODE_ENV` or `VERCEL_ENV` is `production` unless
  `ALLOW_PRODUCTION_SEED=1`. A client's live database must never be seeded.

## 8. Smoke test

After each deploy, check (replace the host with the client's):

- [ ] `/api/health/ready` answers 200 and every check reads `ok` /
      `up_to_date`. A 503 names the failing piece: `database: fail` (wrong
      `DATABASE_URL` or Neon suspended), `redis: not_configured` (sign-in
      will answer 503 "Service temporarily unavailable"), `migrations:
      pending` (run `db:migrate`), `secrets: missing` (`SESSION_SECRET` or a
      32-byte `IDENTITY_ENCRYPTION_KEY`). The function log carries one
      `[config] ...` line per refused request naming what is missing.
- [ ] `/login` loads and shows the client's name, logo and colour (and not
      "HIMS" when `BRAND_NAME` is set).
- [ ] `/patient-portal/login` loads with the same branding.
- [ ] `/book` loads with the client's branding.
- [ ] Page title (`<title>`) is the client's name.
- [ ] Signing in as the admin works, including MFA, and sets a cookie named
      `<BRAND_COOKIE_PREFIX>_session`.
- [ ] Role dashboards, one account per role (create test accounts, remove
      them afterwards):
  - admin: `/` (admin dashboard), `/audit-log`, Settings
  - coordinator: `/` (coordinator dashboard), Patients, Workbook
  - principal investigator: `/` ("My Patients"), a patient chart
  - front desk: `/front-desk/check-in`
  - pharmacy: `/pharmacy`
  - billing: `/billing`
  - labs: `/labs`
- [ ] A role is redirected away from a page it may not see (for example a
      billing user opening `/audit-log`).
- [ ] An email or SMS one-time code arrives, carrying the client's name.
- [ ] Authenticator enrolment shows the client's name as issuer.
- [ ] An upload (document or insurance card) succeeds (Blob configured).
- [ ] Logging out and back in works; no other client's data is visible.
- [ ] No `DISABLE_STAFF_MFA`, `SEED_*` or `ALLOW_PRODUCTION_SEED` variable is
      set in the production environment.

## Lab report PDFs

Released lab reports are PDFs generated on the server with `pdf-lib` and stored
privately in the Blob store (`lab-reports/<requisition>/<report number>-<random>.pdf`).
Staff download them from the chart and the lab worklist, patients from the
portal; every download is audited and the stored file's address never reaches
the browser.

Known limitation: the PDF uses the standard Latin (WinAnsi) fonts only. No font
with Indian-script glyphs ships with the app, and none is downloaded at runtime,
so a name or value written in Devanagari, Tamil, Bengali or any other
non-Latin script prints as `[non-Latin text]`, with a note under the patient
details pointing to the chart or the patient portal, where the name is shown
correctly. Latin-1 accents (é, ü) print normally; the rupee sign prints as
`Rs.`. To lift this, add `@pdf-lib/fontkit` and a font such as Noto Sans
Devanagari to the repository and embed it in `src/lib/labs/report-pdf.ts`.

## Rolling back and rotating

- Roll back an app change from the Vercel deployments list (Promote a
  previous deployment). Database changes are not rolled back: migrations are
  additive, so the previous deployment runs on the migrated schema. To undo
  data damage, use Neon point-in-time restore (OPERATIONS.md), never a
  hand-written down-migration on the live database.
- Rotating `SESSION_SECRET` signs everyone out. Rotating
  `IDENTITY_ENCRYPTION_KEY` requires re-encrypting stored values first;
  do not change it on a live database without that plan. Backups, restore
  drills and key custody: [OPERATIONS.md](OPERATIONS.md).
