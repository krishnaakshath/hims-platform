# Operating a HIMS deployment: database, backups, keys

This is the runbook for the data side of a client deployment. Setting one up
is in [DEPLOYING.md](DEPLOYING.md); this covers keeping it safe afterwards.

## Where the data lives

| Store | Holds | Source of truth? | If lost |
|---|---|---|---|
| **Postgres** (Neon) | Every record: patients, encounters, notes, orders, results, prescriptions, MAR, bills, receipts, refunds, coding, audit log, staff accounts, settings. Aadhaar/ID numbers and MFA secrets are stored AES-256-GCM encrypted with `IDENTITY_ENCRYPTION_KEY` | **Yes** | Restore from Neon point-in-time restore or a `db:backup` dump |
| **Vercel Blob** (private store) | Files: uploaded documents (`documents/...`), insurance card images, imaging attachments, released lab report PDFs (`lab-reports/...`). Postgres holds each file's address and metadata | **Yes, for the files** | Postgres rows survive but downloads fail. Blob is not covered by Neon backups: back it up separately (below) |
| **Upstash Redis** | Read-through cache (patient lists, dashboards), rate-limit counters, one-time sign-in codes (hashed, minutes-long TTL), used-TOTP markers (replay protection) | **No**, never | Nothing permanent. The cache refills from Postgres; codes in flight must be re-sent; rate-limit windows restart. While Redis is *down or unset*, sign-in, MFA and the booking widget answer 503 (fail closed) |
| **Vercel env vars** | Secrets and configuration (`DATABASE_URL`, `SESSION_SECRET`, `IDENTITY_ENCRYPTION_KEY`, `ADMIN_*`, `BRAND_*`, ...) | **Yes, for keys** | See "Encryption keys". Keep an escrowed copy of the two keys outside Vercel |

Redis must never become a source of truth: anything that has to survive goes
in Postgres.

## Migrations (`npm run db:migrate`)

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
| `npm run db:migrate:status` | Lists every file as `applied`, `adopted`, `pending` or `CHANGED`; exit 2 if any applied file changed |
| `npm run db:migrate -- --dry-run` | Shows what would run; writes nothing |
| `npm run db:migrate` | Applies what is pending (see DEPLOYING.md section 4) |
| `npm run db:schema-diff -- <db A> <db B>` | Compares two databases' columns, constraints, indexes, triggers, enums, functions and extensions |

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
- **Neon**: use the direct endpoint (`DATABASE_URL_UNPOOLED`); the runner
  refuses a `-pooler` host. TLS is on for every non-local host (`src/db/url.ts`).

Verified on 2026-10-08: a database built from empty by `db:migrate` and the
long-running development database (built by `db:push` plus hand-applied SQL)
are identical under `db:schema-diff` (1045 columns, 359 constraints, 170
indexes, 5 triggers, 84 enums, 2 functions, 3 extensions), and the
development database adopts cleanly with a no-op second run.

## Backups

Two layers. Neon is the primary one; dumps are the independent copy.

### 1. Neon point-in-time restore (primary)

Neon keeps a history of every write (the "restore window"; its length
depends on the plan: set it to at least 7 days, 30 for production clinics).
Within that window any moment can be restored:

1. Neon console > the project > **Branches** > **Restore** (or create a branch
   from a past timestamp to inspect first, without touching production).
2. Prefer "restore to a new branch at time T", check it (below), then point
   the Vercel project's `DATABASE_URL`/`DATABASE_URL_UNPOOLED` at that branch
   and redeploy, or restore the main branch in place once you are sure.
3. Restoring in place discards writes after T: export anything needed from
   the old state first (Neon keeps a backup branch of the pre-restore state).

### 2. Logical dumps (`npm run db:backup`)

```bash
DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:backup             # -> backups/hims-<db>-<UTC time>.dump
DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:backup -- --out /secure/path
```

`pg_dump --format=custom` (compressed), owner and grants stripped, a
`.sha256` written next to it, then read back with `pg_restore --list`. It
needs PostgreSQL client tools at least as new as the server (`brew install
libpq`, or `postgresql-client-17`); without them it prints how to install
them and exits 2. `PG_BIN_DIR` selects a specific installation. The password
is passed in the environment, never on the command line.

A dump contains every patient record. Store it encrypted (an encrypted
bucket or an encrypted volume), never on a shared drive, never in git
(`backups/` is git-ignored), and never next to the encryption key.

**Retention** (adjust to the client's legal advice; Indian clinical
establishments commonly keep in-patient records for at least 3 years and
clinical-trial records for longer):

| Copy | Frequency | Keep |
|---|---|---|
| Neon history | continuous | 7-30 days (plan setting) |
| `db:backup` dump | daily (automate from a trusted runner) | 30 daily, 12 monthly |
| Pre-change dump | before every `db:migrate` on production | until the next release is stable |
| Blob store copy | weekly, and before bulk deletions | 12 monthly |

**Blob files** are not in the dump. Copy the store with the Vercel Blob API
or CLI (list and download every object under `documents/`, `lab-reports/`,
insurance card and imaging paths) to the same encrypted storage. A dump and a
Blob copy taken minutes apart are consistent enough: a row whose file is
missing shows a failed download, never a wrong file.

### Restore drill (quarterly, and after any backup change)

`npm run db:restore-check -- <dump>` restores a dump into an empty scratch
database and checks it. It refuses the live database and any non-empty target.

1. Create an empty target: a new Neon branch with no data, or a local
   database. Put its direct URL in `RESTORE_DATABASE_URL`.
2. Run:
   ```bash
   RESTORE_DATABASE_URL='postgres://...' npm run db:restore-check -- backups/hims-neondb-20261008T050403Z.dump
   ```
3. Check the output:
   - [ ] `checksum ok` (the dump matches its `.sha256`)
   - [ ] `ledger: every migration in this checkout is recorded` (or a known
         number of newer migrations if the code is ahead of the dump)
   - [ ] `billing immutability triggers present`
   - [ ] row counts of patients, users, encounters, invoices, payments,
         audit log, lab reports and documents match production at dump time
   - [ ] `restore drill passed`
4. Point a local app at the restored copy (with the client's
   `IDENTITY_ENCRYPTION_KEY` from escrow) and open one patient with an
   Aadhaar/ID number: it must decrypt. This proves the key escrow too.
5. Record date, dump name, duration and result in the client's operations log.
6. Delete the scratch branch/database: it holds real patient data.

Last drill run during development (2026-10-08, local): dump 0.4 MB, restore
under one second, schema identical to the source under `db:schema-diff`.

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

It also deletes `documents` rows without deleting their Blob files, so a
deleted patient's uploads stay in the Blob store (unreachable from the app,
but present). Recommendation: replace hard delete with an archive flag for
any patient who has clinical or trial data, keep hard delete only for
registrations created in error with no clinical activity, and remove the
Blob files in the same operation.

## Health checks

`GET /api/health` (always 200 while serving) and `GET /api/health/ready`
(200 only when all pass, else 503) are public and answer only:

```json
{"status":"ok|degraded|down","checks":{"database":"ok|fail","redis":"ok|fail|not_configured","migrations":"up_to_date|pending|unknown","secrets":"ok|missing"}}
```

No variable names, values or error text. `down` = database unreachable or
secrets missing; `degraded` = Redis or migrations not right. Results are
reused for 5 seconds. For detail, read the function logs: routes that need
Redis or the database log one line per refused request, for example
`[config] REDIS not configured: login is unavailable` or
`[config] database unreachable (28P01): login is unavailable`, while the
client receives a generic 503 "Service temporarily unavailable".
