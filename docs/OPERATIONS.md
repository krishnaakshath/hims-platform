# Operating a HIMS deployment: database, backups, keys

This is the runbook for the data side of a client deployment. Setting one up
is in [DEPLOYING.md](DEPLOYING.md); this covers keeping it safe afterwards.

## Where the data lives

| Store | Holds | Source of truth? | If lost |
|---|---|---|---|
| **Postgres** (`postgres` service, volume `hims_pg`) | Every record: patients, encounters, notes, orders, results, prescriptions, MAR, bills, receipts, refunds, coding, audit log, staff accounts, settings. Aadhaar/ID numbers and MFA secrets are stored AES-256-GCM encrypted with `IDENTITY_ENCRYPTION_KEY` | **Yes** | Restore a `pg_dump` backup (below) |
| **Local file store** (volume `hims_blobs`, `/app/data/blobs` in the app) | Files: uploaded documents, insurance card images, imaging attachments, released lab report PDFs, RCM claim copies and attachments. Stored under hashed names with a sidecar holding the content type and a SHA-256; Postgres holds each file's opaque `local:` address and metadata | **Yes, for the files** | Postgres rows survive but downloads fail. Not in the database dump: back the volume up separately (below) |
| **Redis** (`redis` service, volume `hims_redis`) | Read-through cache (patient lists, dashboards), rate-limit counters, one-time sign-in codes (hashed, minutes-long TTL), used-TOTP markers (replay protection) | **No**, never | Nothing permanent. The cache refills from Postgres; codes in flight must be re-sent; rate-limit windows restart. While Redis is *down*, sign-in, MFA and the booking widget answer 503 (fail closed) |
| **`.env.docker`** on the host | Secrets and configuration (`SESSION_SECRET`, `IDENTITY_ENCRYPTION_KEY`, `INTEGRATION_PAYLOAD_KEY`, `ADMIN_*`, `BRAND_*`, ...) | **Yes, for keys** | See "Encryption keys". Keep an escrowed copy of the keys off the host |

Redis must never become a source of truth: anything that has to survive goes
in Postgres.

## Migrations (automatic: the `migrate` service and the app entrypoint)

- `scripts/db/baseline.sql`: the full schema as of the day the ledger was
  introduced (exported from `src/db/schema.ts` with `drizzle-kit export`).
  Frozen: a test pins its checksum.
- `scripts/migrations/YYYY-MM-DD-*.sql`: every change since, applied in name
  order. Each is idempotent and wraps itself in `BEGIN; ... COMMIT;`. Files
  with no `BEGIN;` are wrapped by the runner; files with `CONCURRENTLY` (or a
  `-- migrate:no-transaction` line) run statement by statement outside a
  transaction.
- `schema_migrations` (filename, sha256 checksum, applied_at, duration_ms,
  how = `applied` | `adopted`): the ledger.

| Command | Does |
|---|---|
| `docker compose run --rm migrate migrate --status` | Lists every file as `applied`, `adopted`, `pending` or `CHANGED`; exit 2 if any applied file changed |
| `docker compose run --rm migrate migrate --dry-run` | Shows what would run; writes nothing |
| `docker compose run --rm migrate` | Applies what is pending (also runs on every `docker compose up` and app start) |
| `docker compose run --rm migrate npm run db:schema-diff -- <db A> <db B>` | Compares two databases' columns, constraints, indexes, triggers, enums, functions and extensions |

Behaviour worth knowing:

- **Empty database**: baseline, then every migration. **Database built by
  `drizzle-kit push` without a ledger**: adopted (baseline recorded, all
  migrations re-run and recorded), after checking it has the HIMS `patients`
  and `users` tables; a non-empty database without them is refused.
- **Concurrency**: a session advisory lock (key 7242011001). A second run
  waits up to two minutes, then exits with "Another migration is running".
- **Failure**: the failing file is rolled back and not recorded, the error
  code and message are printed, the exit code is 1, and later files are not
  attempted. Fix forward with a new file; re-running is safe.
- **Drift**: if a recorded file's content changed, nothing runs and each
  changed file is printed with both checksums. Restore the original text.
- **TLS**: off for the compose `postgres` service and loopback, on for any
  other host (`src/db/url.ts`).

Verified on 2026-10-08: a database built from empty by `db:migrate` and the
long-running development database (built by `db:push` plus hand-applied SQL)
are identical under `db:schema-diff` (1045 columns, 359 constraints, 170
indexes, 5 triggers, 84 enums, 2 functions, 3 extensions), and the
development database adopts cleanly with a no-op second run.

## Backups

Everything to back up is on the host: the database (volume `hims_pg`), the
file store (volume `hims_blobs`) and `.env.docker` (keys; escrow it, do not
store it next to the dumps). Redis needs no backup. Commands below run from
the repository directory on the host.

### 1. Database dump (`pg_dump` in the postgres container)

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U postgres -d hims \
  --format=custom --no-owner --no-privileges > backups/hims-$(date -u +%Y%m%dT%H%M%SZ).dump
# same thing: npm run docker:backup
sha256sum backups/hims-*.dump > backups/SHA256SUMS      # macOS: shasum -a 256
```

The dump streams out of the container to the host; the password never
appears on a command line. To check it is readable:
`docker compose exec -T postgres pg_restore --list < backups/<file>.dump | head`.

Alternative inside the app image (pg_dump 17 client, writes a `.sha256` and
verifies the dump with `pg_restore --list`):

```bash
docker compose exec app npm run db:backup -- --out /tmp/backups
docker compose cp app:/tmp/backups ./backups/
```

### 2. File store (`hims_blobs` volume)

```bash
docker compose exec -T app tar czf - -C /app/data blobs > backups/blobs-$(date -u +%Y%m%dT%H%M%SZ).tgz
```

A database dump and a file-store archive taken minutes apart are consistent
enough: a row whose file is missing shows a failed download, never a wrong
file (each file carries its own SHA-256 and is refused on mismatch).

Automate both daily from host cron (as a user in the `docker` group), copy
them to encrypted storage off the host (in India), and prune by the retention
below. A dump contains every patient record: store it encrypted, never on a
shared drive, never in git (`backups/` is git-ignored), and never next to the
encryption keys.

**Retention** (adjust to the client's legal advice; Indian clinical
establishments commonly keep in-patient records for at least 3 years and
clinical-trial records for longer):

| Copy | Frequency | Keep |
|---|---|---|
| Database dump | daily | 30 daily, 12 monthly |
| Pre-upgrade dump | before every `git pull` + `up -d` | until the next release is stable |
| File store archive | daily (or weekly for small sites), and before bulk deletions | 30 daily, 12 monthly |

### Restore

Into a fresh stack (or after `docker compose down` + removing the volumes,
**only** when you mean to replace the data):

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U postgres -d hims --no-owner --no-privileges < backups/<file>.dump
docker compose up -d                                   # migrate brings it up to this checkout
docker compose exec -T app sh -c 'tar xzf - -C /app/data' < backups/blobs-<time>.tgz
```

Restore into an empty `hims` database: on a database that already has the
schema, `pg_restore` reports conflicts. The app must run with the same
`IDENTITY_ENCRYPTION_KEY` the data was written with.

### Restore drill (quarterly, and after any backup change)

`npm run db:restore-check -- <dump>` restores a dump into an EMPTY scratch
database and checks it. It refuses the live database and any non-empty target.
Inside the stack:

```bash
docker compose exec -T postgres psql -U postgres -c 'create database hims_restore_check'
docker compose cp backups/<file>.dump app:/tmp/drill.dump
docker compose exec -e RESTORE_DATABASE_URL='postgres://postgres:<HIMS_DB_PASSWORD>@postgres:5432/hims_restore_check' \
  app npm run db:restore-check -- /tmp/drill.dump
```

Check the output:

- [ ] `checksum ok` (when a `.sha256` sits next to the dump)
- [ ] `ledger: every migration in this checkout is recorded` (or a known
      number of newer migrations if the code is ahead of the dump)
- [ ] `billing immutability triggers present`
- [ ] row counts of patients, users, encounters, invoices, payments, audit
      log, lab reports and documents match production at dump time
- [ ] `restore drill passed`

Then extract a file-store archive into a scratch directory and confirm a few
files are present, record date, dump name, duration and result in the
client's operations log, and drop the scratch database
(`docker compose exec -T postgres psql -U postgres -c 'drop database hims_restore_check'`):
it holds real patient data.

## Encryption keys

`IDENTITY_ENCRYPTION_KEY` (32 bytes, base64) encrypts Aadhaar and other ID
numbers and every staff and patient TOTP secret.

- **Losing it is permanent**: the encrypted ID numbers cannot be recovered by
  anyone, from any backup, and every TOTP enrolment stops working (users must
  re-enrol after an admin resets their MFA). Database backups do not help.
- Escrow it at creation: two copies in separate places the clinic controls
  (e.g. a password manager vault owned by the clinic and a sealed offline
  copy), never in the same place as database dumps, never in git or chat.
- Rotation means decrypting and re-encrypting every stored value with a
  migration script under both keys; never change the variable alone on a
  live database.

`SESSION_SECRET` signs staff sessions, patient sessions and the pending-MFA
and Google sign-in cookies. Nothing stored depends on it. Rotating it signs
everyone out and abandons sign-ins in progress; that is the right response to
a suspected leak. Losing it costs one sign-in for each user, nothing else.

`ADMIN_PASSWORD_HASH` is a password hash, not a key; the admin can be reset
by setting a new hash.

## Data safety review ("nothing is lost")

Reviewed 2026-10-08 against the schema built from empty.

**Foreign keys.** 179 foreign keys. 165 are `NO ACTION`: deleting a parent
row that still has children fails, so nothing is removed implicitly. Only two
cascade, both detail rows meaningless without their parent and only deleted
together with the patient: `coding_query_responses -> coding_queries` and
`follow_up_contact_attempts -> follow_up_orders`. Twelve are `SET NULL`, all
optional cross-links (an encounter's admission, appointment or assignment; a
follow-up's originating encounter, admission or lab order; a requisition's
originating encounter or follow-up; a home visit's encounter; a lab order's
home visit); the record itself survives. `tests/db/migrate-runner.test.ts`
pins this inventory, so a new `CASCADE` needs a deliberate test change.

Columns that look like references but have no FK, by design: `audit_log.patient_id`
(the audit trail must outlive the patient), `signatures.signable_id` and
`notification_deliveries.related_id` (polymorphic), `patients.primary_member_id`,
`secondary_member_id` and `payers.payer_id` (insurer identifiers, not row ids),
`lab_orders.sample_id` (barcode), `form_chart_discrepancies.question_id`
(form question key), `lab_requisitions.legacy_lab_order_id` (migration trace).

**Audit log.** `audit_log` is append-only by convention: no application code
updates or deletes it (checked: no `update(auditLog)` or `delete(auditLog)`
outside tests), and it has no FK, so deleting a patient keeps their audit
history. It is **not enforced in the database**: the test suite deletes its
own probe rows. Recommended next step once tests run on throwaway databases:
a migration adding a trigger that rejects UPDATE and DELETE on `audit_log`,
like the SP4 billing triggers.

**Billing records** (`invoices` once issued, `invoice_lines`, `credit_notes`,
`patient_payments`, `refunds`) are immutable in the database: triggers reject
any change or delete (SQLSTATE 55000).

**Patient deletion.** There is no soft delete. `DELETE /api/patients/[anonId]`
(admin only) calls `deletePatient`, which removes the patient and every
linked row in one transaction and writes an audit row in the same
transaction. It refuses (409) when the patient has a finalised or cancelled
invoice, a payment or a refund. Owner decisions needed, because the delete
also hard-deletes, without refusing:

- clinical records (encounters, notes, diagnoses, prescriptions, MAR, lab
  orders, results and released reports, care plans): Indian practice is to
  retain in-patient records for at least 3 years;
- clinical-trial records (`adverse_events`, `drug_accountability_entries`,
  signatures, consent submissions), which trial regulations require to be
  kept;
- legacy `charges` and `insurance_claims` rows, even when submitted or paid.
  The RCM work (SP7) adds claim retention rules in its own branch; do not
  duplicate them here.

It also deletes `documents` rows without deleting their stored files, so a
deleted patient's uploads stay in the `hims_blobs` volume (unreachable from the
app, but present). Recommendation: replace hard delete with an archive flag for
any patient who has clinical or trial data, keep hard delete only for
registrations created in error with no clinical activity, and remove the
files in the same operation.

## Health checks

`GET /api/health` (always 200 while serving) and `GET /api/health/ready`
(200 only when all pass, else 503) are public and answer only:

```json
{"status":"ok|degraded|down","checks":{"database":"ok|fail","redis":"ok|fail|not_configured","migrations":"up_to_date|pending|unknown","secrets":"ok|missing","blob":"ok|fail"}}
```

No variable names, values or error text. `down` = database unreachable or
secrets missing; `degraded` = Redis or migrations not right, or the file store
cannot be written (`blob` writes and removes a probe file in the store
directory). Results are reused for 5 seconds. The app container's Docker
health check uses the same endpoint (`docker compose ps` shows `healthy`).

For detail, read the logs (`docker compose logs app`): routes that need
Redis, the database or the file store log one line per refused request, for
example `[config] REDIS not configured: login is unavailable`,
`[config] database unreachable (28P01): login is unavailable` or
`[config] BLOB_DRIVER not configured: lab report download is unavailable`,
while the client receives a generic 503 "Service temporarily unavailable".
