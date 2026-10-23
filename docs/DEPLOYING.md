# Deploying HIMS for a client (Docker only)

One client = one host = one Docker Compose stack = one set of volumes and
secrets. Everything runs on that host: Postgres, Redis, the file store and the
app. There is no cloud database, cache or file store, and nothing in the stack
calls the internet at run time unless the operator configures an optional
integration (SMTP, SMS/WhatsApp, Google SSO, ABDM/NHCX) or runs the WHO
ICD-10 loader. Branding is configuration (`BRAND_*`), so the same repository
serves every client.

## What runs

| Service | Image | Role | Data |
|---|---|---|---|
| `postgres` | `postgres:15-alpine` | the database (source of truth) | volume `hims_pg` |
| `redis` | `redis:7-alpine` | cache, rate limits, one-time codes | volume `hims_redis` (disposable) |
| `redis-http`, `redis-rest` | `hiett/serverless-redis-http`, `node:22-alpine` | the Upstash-compatible REST endpoint the app talks to (`scripts/dev/redis-rest-shim.mjs` in front) | none |
| `migrate` | this repository's image | one-shot: applies pending migrations, exits 0 | none |
| `app` | this repository's image | Next.js on port 3000 (host `APP_PORT`, default 3001), non-root, health-checked | volume `hims_blobs` at `/app/data/blobs` (uploaded and generated files) |
| `seed` (profile) | this repository's image | one-shot demo data | none |
| `codes` (profile) | this repository's image | one-shot WHO ICD-10 download and import (the only internet use) | none |
| `test` (profile) | this repository's image, `test` target | the test suite against a throwaway `hims_test` database | none |

Host ports (all overridable when starting compose): app `APP_PORT` (3001) on
`APP_BIND` (0.0.0.0); Postgres `POSTGRES_PORT` (55432) and Redis REST
`REDIS_REST_PORT` (8079), both on `PORT_BIND` (127.0.0.1, loopback only).

## Host requirements and sizing

- Linux host with Docker Engine 24+ and the Compose plugin (v2.20+). macOS
  with Docker Desktop works for evaluation.
- Small clinic (up to ~30 concurrent staff): 2 vCPU, 4 GB RAM, 40 GB SSD.
  Hospital (up to ~150 concurrent staff): 4 vCPU, 8 GB RAM, 100 GB SSD plus
  room for uploaded files and backups. Building the image (`next build`) is
  the most memory-hungry step; build on a machine with spare RAM if the host is small.
- Disk grows with the database and the `hims_blobs` volume (documents,
  insurance cards, imaging, lab report PDFs); watch both.
- These figures are starting points, not load-tested numbers.

**Data residency.** Every record and file stays on this host (the Docker
volumes). Choosing where the host runs (an Indian data centre or an India
region of a hosting provider, or on the hospital's premises) is what puts the
data in India. Backups go where you copy them; keep those in India too.

## First run

```bash
git clone <this repository> hims && cd hims
cp .env.docker.example .env.docker
```

Edit `.env.docker` (it is gitignored; every variable is documented inline):

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # IDENTITY_ENCRYPTION_KEY  (escrow it now: docs/OPERATIONS.md)
openssl rand -base64 32   # INTEGRATION_PAYLOAD_KEY
```

Also set `NEXT_PUBLIC_APP_URL` (the public https URL), `ADMIN_EMAIL`,
`ADMIN_NAME` and `ADMIN_PASSWORD_HASH` (generator: README, "Admin password
hash"), and the client's `BRAND_*`. Leave the demo switches empty for a real
deployment.

Optional, before the **first** `up` only: put `HIMS_DB_PASSWORD` and
`HIMS_REDIS_TOKEN` in a `.env` file next to `docker-compose.yml` to replace
the default internal credentials (Postgres keeps the password it was
initialised with; changing it later needs `ALTER USER` as well).

```bash
docker compose up -d --build
docker compose ps                 # app: "healthy" within a minute or two
curl -s http://127.0.0.1:3001/api/health
```

`up` builds the image, starts Postgres and Redis, runs the one-shot `migrate`
service (on an empty database: the frozen baseline and then every file in
`scripts/migrations/`), and starts the app only after `migrate` exited 0. The
app's entrypoint (`scripts/docker-entrypoint.sh`) also waits for the database
and re-runs the migration runner on every start, which is a no-op when nothing
is pending. Expected health:

```json
{"status":"ok","checks":{"database":"ok","redis":"ok","migrations":"up_to_date","secrets":"ok","blob":"ok"}}
```

Any other word names the missing piece without values: `secrets: missing`
(`SESSION_SECRET` empty or `IDENTITY_ENCRYPTION_KEY` not 32 bytes), `blob:
fail` (the `hims_blobs` volume is not writable), `migrations: pending`
(`docker compose run --rm migrate`).

### First admin, or demo data

**Real deployment.** No staff accounts exist after migration. The admin
defined by `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` is always available and needs
no database row:

1. Sign in at `/login` as that admin and complete MFA enrolment.
2. In Settings, create the other staff accounts. Each gets a generated
   password, shown once; hand it over securely and have the person change it.
3. Enable patient portal access per patient from the patient page (admin only;
   a random password is shown once).

**Demo / evaluation stack.** The seed writes fictional patients and one demo
account per role (`<role>@<SEED_EMAIL_DOMAIN>`, all sharing
`SEED_DEMO_PASSWORD`, 12+ characters, no default). The container runs with
`NODE_ENV=production`, so the seed refuses unless `ALLOW_PRODUCTION_SEED=1` is
set in `.env.docker`; set it only on a demo stack. Then either:

```bash
docker compose --profile seed run --rm seed     # once, by hand
# or SEED_ON_START=true: the app seeds on start when the database has no patients and no users
```

On a populated database the seed only tops up reference data; `SEED_RESET=1`
clears the demo data and rebuilds it. Every identifier is synthetic (Aadhaar
test values start `9999 0000` and are stored only encrypted; ABHA numbers
start `99-9999-0000`; mobiles `+91 90000`).

### Code sets (optional)

No code sets ship with the app (the seed loads fictional `SAMPLE-` sets for
demos). To load WHO ICD-10 (2019):

```bash
docker compose --profile codes run --rm codes
```

This is the **only** part of the stack that uses the internet: it downloads
`https://icdcdn.who.int/icd10/claml/icd102019en.xml.zip` (who.int hosts only;
it prints the SHA-256), converts it and imports it as version `WHO-2019`. It
runs only when you start it. Offline, pass a file you downloaded elsewhere:

```bash
docker compose --profile codes run --rm -v /path/icd102019en.xml.zip:/in/who.zip:ro codes --file /in/who.zip
```

Other licensed sets (ICD-10-PCS, SNOMED CT, LOINC, PM-JAY HBP) are imported
with `docker compose run --rm migrate npm run codes:import -- ...` after
copying the file into the container, or through the web importer; see
[CODE-SYSTEMS.md](CODE-SYSTEMS.md).

## HTTPS (reverse proxy, operator-provided)

The stack serves plain HTTP on `APP_PORT`. Put the operator's own reverse
proxy in front for TLS, and set `APP_BIND=127.0.0.1` when the proxy runs on
the same host so the app is not reachable directly. The proxy must **replace**
`X-Forwarded-For` with the real client address (rate limits key on its first
entry). Examples (not part of the stack):

Caddy (automatic certificates):

```
hims.example.org {
    reverse_proxy 127.0.0.1:3001 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

nginx:

```
server {
    listen 443 ssl http2;
    server_name hims.example.org;
    ssl_certificate     /etc/ssl/hims/fullchain.pem;
    ssl_certificate_key /etc/ssl/hims/privkey.pem;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Upgrades

```bash
git pull
docker compose build
docker compose up -d
```

`up` re-runs `migrate` before the new app starts; migrations are additive and
idempotent, and the runner refuses to start if an already-applied file was
edited. Take a database backup first (docs/OPERATIONS.md). Check
`/api/health` afterwards. To roll back the app, check out the previous commit
and repeat `build` + `up -d`; the previous version runs on the migrated
schema. Database changes are never rolled back by hand on a live database:
restore a backup instead.

## Environment variables

`.env.docker.example` is the authoritative, commented list (grouped:
backing services, secrets, admin, branding, features, demo switches, seed,
optional integrations). `npm run check:env-docs` (and its test) fails if the
code reads a variable that file does not document.

> **Brand changes need a rebuild.** `BRAND_*` is read when the app starts, but
> pages prerendered at build time keep the values the image was built with:
> after editing them run `docker compose build app && docker compose up -d`.
> **Changing `BRAND_COOKIE_PREFIX` signs everyone out**, so set it once before
> go-live.

Never set `DISABLE_STAFF_MFA`, `DEMO_FEATURES`, `ABDM_USE_MOCKS`,
`ALLOW_DEMO_MOCKS`, `SEED_ON_START` or `ALLOW_PRODUCTION_SEED` on a deployment
holding real data.

## Migrations: rules

- The `migrate` service runs `npm run db:migrate` (`scripts/db/migrate.ts`)
  inside the image. On an empty database it applies `scripts/db/baseline.sql`
  and then every `scripts/migrations/*.sql` in name order, including the parts
  `schema.ts` cannot express (the `btree_gist` and `pg_trgm` extensions, the
  `tariff_rates_no_overlap` exclusion constraint, the `codes_display_trgm_idx`
  index, the billing immutability triggers). An existing database built with
  `db:push` before the ledger existed is adopted: baseline recorded, every
  (idempotent) migration re-run and recorded, nothing dropped.
- `scripts/db/baseline.sql` is frozen; every change is a new dated file in
  `scripts/migrations/`. The runner records a checksum per file and refuses to
  run when an applied file changes.
- **Never** run `npm run db:push` (or `db:generate`) against a client or
  shared database: `drizzle-kit push` diffs `schema.ts` against the whole
  database and offers to drop what it does not declare.
- Status: `docker compose run --rm migrate migrate --status`; dry run:
  `docker compose run --rm migrate migrate --dry-run`.

## Smoke test

After each deploy or upgrade:

- [ ] `/api/health/ready` answers 200 and every check reads `ok` / `up_to_date`.
- [ ] `/login`, `/patient-portal/login` and `/book` load with the client's
      name, logo and colour; the `<title>` is the client's name.
- [ ] Signing in as the admin works, including MFA, and sets a cookie named
      `<BRAND_COOKIE_PREFIX>_session`.
- [ ] Role dashboards load for one account per role (admin `/`, front desk
      `/front-desk/check-in`, pharmacy `/pharmacy`, billing `/billing`, labs `/labs`).
- [ ] A role is redirected away from a page it may not see.
- [ ] An upload (document or insurance card) succeeds and downloads again
      (proves the `hims_blobs` volume).
- [ ] If configured: an email or SMS one-time code arrives with the client's name.
- [ ] None of the demo switches above is set.

## Lab report PDFs

Released lab reports are PDFs generated on the server with `pdf-lib` and stored
in the local file store (`lab-reports/<requisition>/<report number>-<random>.pdf`
on the `hims_blobs` volume, under hashed file names). Staff download them from
the chart and the lab worklist, patients from the portal; every download is
audited and the stored file's address never reaches the browser.

Known limitation: the PDF uses the standard Latin (WinAnsi) fonts only, so a
name written in a non-Latin script prints as `[non-Latin text]` with a note
pointing to the chart or portal. To lift this, add `@pdf-lib/fontkit` and a
font such as Noto Sans Devanagari to the repository and embed it in
`src/lib/labs/report-pdf.ts`.

## Rotating secrets

Rotating `SESSION_SECRET` signs everyone out. Rotating
`IDENTITY_ENCRYPTION_KEY` requires re-encrypting stored values first; never
change it on a live database without that plan. Key custody, backups and
restore drills: [OPERATIONS.md](OPERATIONS.md).

## Host development against the stack

The published loopback ports let a developer run the app or the test suite on
the host against this stack. Host scripts read configuration only from the
environment (there is no `.env.local` and no dotenv loading):

```bash
docker compose up -d postgres redis redis-http redis-rest
export DATABASE_URL=postgres://postgres:hims_local_dev@127.0.0.1:55432/hims
export KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=hims_local_redis_token
npm run db:migrate && npm run dev
```

The test suite does not need host Node at all: `docker compose --profile test
run --rm test` (README, "Tests").
