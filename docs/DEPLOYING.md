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
| `DATABASE_URL` | yes | Client's own Postgres |
| `SESSION_SECRET` | yes | Unique per client, 32+ random chars: `openssl rand -base64 48` |
| `IDENTITY_ENCRYPTION_KEY` | yes | Unique per client, 32 bytes base64: `openssl rand -base64 32`. Back it up; losing it makes encrypted ID numbers unreadable |
| `NEXT_PUBLIC_APP_URL` | yes | Public https URL of the deployment |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD_HASH` | yes | Always-available admin account. Hash generator: see README, "Admin password hash" |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes | Rate limits, MFA replay protection, cache. Rate limiters fail closed without Redis |
| `BLOB_READ_WRITE_TOKEN` | yes | Insurance cards, imaging, documents |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | yes for email codes | One-time sign-in codes by email |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | for SMS codes | |
| `BRAND_NAME`, `BRAND_LEGAL_NAME`, `BRAND_TAGLINE`, `BRAND_SUPPORT_EMAIL`, `BRAND_LOGO_URL`, `BRAND_PRIMARY_COLOR`, `BRAND_COOKIE_PREFIX` | optional | See README, "White-label a client". Read at build time |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional | Admin Google SSO; routes answer 503 when unset |
| `LIS_INTEGRATION_TOKEN` | optional | Bearer token for `/api/webhooks/fhir-labs`; unset = webhook disabled |
| `DISABLE_STAFF_MFA` | never in production | Demo toggle that skips staff MFA |
| `SEED_EMAIL_DOMAIN`, `SEED_DEMO_PASSWORD`, `ALLOW_PRODUCTION_SEED` | non-production only | See "Seeding" |

Set secrets with `vercel env add NAME production` (or the dashboard); never
commit them. Generate each client's secrets fresh.

> **Brand changes need a rebuild.** `BRAND_*` is baked in at build time. After
> editing it, redeploy (`vercel --prod`, or "Redeploy" without the build
> cache). **Changing `BRAND_COOKIE_PREFIX` signs everyone out**, so set it once
> before go-live.

## 4. Create the schema (migration)

Run once against the client's new, **empty** database, from a machine that has
the client's `DATABASE_URL` (for example after `vercel env pull .env.local`
linked to the client's project):

```bash
npm ci
npm run db:push        # dotenv -e .env.local -- drizzle-kit push
```

`db:push` applies `src/db/schema.ts` to the database. It is only safe on a
fresh per-client database: against a database that holds other tables it
would drop anything the schema does not declare. Never point it at a shared
or populated one; for later schema changes, apply additive SQL by hand
(`scripts/apply-sql.mjs`, see the README). Verify the tables exist before
continuing.

To avoid a local `.env.local`, you can pass the variable inline instead:
`DATABASE_URL=... npx drizzle-kit push`.

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

## Rolling back and rotating

- Roll back an app change from the Vercel deployments list (Promote a
  previous deployment). Database changes are not rolled back automatically.
- Rotating `SESSION_SECRET` signs everyone out. Rotating
  `IDENTITY_ENCRYPTION_KEY` requires re-encrypting stored values first;
  do not change it on a live database without that plan.
