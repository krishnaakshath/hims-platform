# Eligibility Auto-Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit staff "Confirm Eligibility" action on a `green` trial screening that, at the moment of confirmation, sends a fixed-template automated message into the patient's existing message thread — this codebase's first system-generated message.

**Architecture:** Three nullable columns land on the existing `patientTrialScreenings` row (`selectionConfirmedAt`, `selectionConfirmedByName`, `selectionNotifiedAt`) rather than a side table, matching `identityVerifications.verified`/`verifiedBy`/`verifiedAt`'s one-to-one shape. The confirmation itself is a single conditional UPDATE guarded by `overall_status = 'green' AND selection_confirmed_at IS NULL` — the same conditional-transition-guard posture used by `administerMedication`, the ADT routes, and `confirmBookingRequest` — so only one of two racing callers can ever win the right to notify. `messages.senderRole` gains a third value, `'system'`, which is a Drizzle-level `text(..., { enum })` widening with (pending Task 1's verification) **no DDL at all**, and `MessageThreadView` — the one component both the staff inbox and the patient portal render — grows a centered banner branch for it.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Zod `.strict()` validation + vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-eligibility-auto-notification.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/eligibility-auto-notify` on branch `feature/eligibility-auto-notify`. This worktree has its own `.env.local` but **no `node_modules` yet** — run `npm install` in this exact directory as the first action of Task 1 before any test command. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and every other active worktree (`.worktrees/unified-patient-record`, `.worktrees/messaging-isolation`, `.worktrees/master-fix`, and a dozen others) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes: this plan adds three **nullable, no-default** columns to the existing `patient_trial_screenings` table and widens one Drizzle-level `text` enum. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately. This session already had a real incident where a `NOT NULL` column with no default was added to an existing shared table and broke every other worktree; all three columns here are nullable precisely so an older worktree's `INSERT` into `patient_trial_screenings` keeps working untouched.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- Every write route uses `.strict()` Zod validation **where it takes a body**. `POST /api/patients/[anonId]/screening/confirm` takes no body at all (spec §3) and therefore declares no schema and never calls `request.json()` — matching the existing bodyless `POST /api/patients/[anonId]/refresh`, which is this route's closest sibling in every other respect too.
- Every staff-initiated state-changing route calls `logAudit(session, <action>, <patientId>)` — here, exactly `logAudit(session, 'confirmed trial eligibility and notified patient', anonId)` (spec §3).
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Role gating per spec §9: view screening evidence = admin, pi, crc, frontdesk (existing, unchanged). **Confirm eligibility (write) = admin, pi, crc — `frontdesk` excluded**, enforced in the route (403) *and* mirrored in the page so the button never renders for a role that cannot use it.
- The automated message body is **fixed template code, never user input, never staff-editable** (spec §5). Its exact text, with the real trial interpolated and **no markdown** (`messages.body` is plain text rendered `whitespace-pre-wrap`; the spec's `**bold**` is spec-document formatting, not part of the copy):

  `Great news — based on your recent screening, you've been selected to move forward with ${trial.name} at ${trial.site}. A member of our care team will reach out soon to schedule your next steps.`

  Sender identity is exactly `senderRole: 'system'`, `senderName: 'Clinsync (Automated)'`.
- Status transitions are conditional UPDATEs guarded in the `WHERE` clause, never a read-then-write — matching `administerMedication`, the ADT admission/discharge routes, and `confirmBookingRequest`.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a staff session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET` — and a patient-portal session cookie the way `src/lib/patient-session.ts` does it — `SignJWT` with `kind: 'patient'`, cookie `clinsync_patient_session`, same secret), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — this codebase's own session history includes a prior implementer fabricating UI verification evidence and being caught; do not repeat that.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **Re-confirming after a verdict regression must still notify, even though `selectionNotifiedAt` is never cleared.** Spec §3 requires a genuinely new notification when a previously-confirmed screening flips away from `green` and is later reconfirmed; spec §4 describes the send-guard as "`selectionNotifiedAt IS NULL`". A bare NULL check would silently swallow that second, legitimate notification forever. The guard must mean *"not yet notified for the current confirmation"* — `selection_notified_at IS NULL OR selection_notified_at < selection_confirmed_at` — which is equivalent to the NULL check on a first confirmation and correct on a re-confirmation. (Task 2)
2. **Two concurrent confirm calls both passing the route-level 409 check before either commits.** Exactly one message row may ever result. The confirm write must be a single conditional UPDATE keyed on `overall_status = 'green' AND selection_confirmed_at IS NULL`, and only its winner may proceed to the notify step. (Task 2)
3. **A screening whose `trialId` resolves to no `trials` row.** The message interpolates `trial.name`/`trial.site`; an unresolvable trial must abort the confirmation entirely rather than sending a patient a message reading "selected to move forward with undefined at undefined". Nothing may be written in that case. (Task 2)
4. **A `'system'` message must not render as anyone's own chat bubble on either surface.** `MessageThreadView`'s existing `isOwn = m.senderRole === viewerRole` test is false for `'system'`, which would left-align it as "the other party" — reading as a patient message in the staff inbox and as a provider message in the portal. The `'system'` branch must be taken before that comparison, on both surfaces, from the one shared component. (Task 4)
5. **The automated message must never be attributed to the confirming clinician.** This is the first write path in the app that inserts a `messages` row on a human's action without that human authoring the text: `logAudit` attributes the *action* to `session.name`, while the message's `senderName` stays `'Clinsync (Automated)'`. A patient must never see fixed template copy signed with a named clinician's name. (Task 2)

---

### Task 1: Schema — selection-confirmation columns + `'system'` sender role

**Files:**
- Modify: `src/db/schema.ts` (`patientTrialScreenings`, `messages`)
- Test: `tests/db/eligibility-notification-schema.test.ts`

**Interfaces:**
- Produces: `patientTrialScreenings.selectionConfirmedAt` / `.selectionConfirmedByName` / `.selectionNotifiedAt`; `messages.senderRole` widened to `'provider' | 'patient' | 'system'`. Consumed by Tasks 2-4.

- [ ] **Step 1: Install dependencies in this worktree**

Run: `npm install` from `/Users/k2a/Desktop/clinsync/.worktrees/eligibility-auto-notify`. This worktree has `.env.local` but no `node_modules`; every later command in this plan needs it.

- [ ] **Step 2: Write the failing test**

Create `tests/db/eligibility-notification-schema.test.ts`. It uses seeded patient `RD-0003` and its existing screening row, restores every field it touches, and deletes every message it creates:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { messages, patientTrialScreenings } from '@/db/schema'

const PATIENT_ID = 'RD-0003'
let original: typeof patientTrialScreenings.$inferSelect
const createdMessageIds: number[] = []

beforeEach(async () => {
  ;[original] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, PATIENT_ID))
})
afterEach(async () => {
  await getDb().update(patientTrialScreenings).set({
    overallStatus: original.overallStatus,
    selectionConfirmedAt: original.selectionConfirmedAt,
    selectionConfirmedByName: original.selectionConfirmedByName,
    selectionNotifiedAt: original.selectionNotifiedAt,
  }).where(eq(patientTrialScreenings.id, original.id))
  if (createdMessageIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdMessageIds))
    createdMessageIds.length = 0
  }
})

describe('eligibility auto-notification schema', () => {
  it('defaults all three selection columns to null on an existing screening', async () => {
    expect(original.selectionConfirmedAt).toBeNull()
    expect(original.selectionConfirmedByName).toBeNull()
    expect(original.selectionNotifiedAt).toBeNull()
  })

  it('stores and reads back the three selection columns', async () => {
    const now = new Date()
    const [updated] = await getDb().update(patientTrialScreenings)
      .set({ selectionConfirmedAt: now, selectionConfirmedByName: 'Dr. Rajiv Kunam', selectionNotifiedAt: now })
      .where(eq(patientTrialScreenings.id, original.id))
      .returning()
    expect(updated.selectionConfirmedByName).toBe('Dr. Rajiv Kunam')
    expect(updated.selectionConfirmedAt).toBeInstanceOf(Date)
    expect(updated.selectionNotifiedAt).toBeInstanceOf(Date)
  })

  it('accepts a system-sender message row', async () => {
    const [row] = await getDb().insert(messages).values({
      patientId: PATIENT_ID,
      senderRole: 'system',
      senderName: 'Clinsync (Automated)',
      body: 'schema probe',
    }).returning()
    createdMessageIds.push(row.id)
    expect(row.senderRole).toBe('system')
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/eligibility-notification-schema.test.ts`
Expected: FAIL — `selectionConfirmedAt` etc. are not properties of the schema object, and `'system'` is not an allowed `senderRole`.

- [ ] **Step 4: Add the schema definitions**

In `src/db/schema.ts`, add to the existing `patientTrialScreenings` table (after `overallStatus`), with a comment explaining why these live here rather than in a side table (spec §2: one-to-one with a screening's outcome, same shape as `identityVerifications.verified`/`verifiedBy`/`verifiedAt`) and why `selectionNotifiedAt` is the one field never cleared:

```ts
  selectionConfirmedAt: timestamp('selection_confirmed_at'),
  selectionConfirmedByName: text('selection_confirmed_by_name'),
  selectionNotifiedAt: timestamp('selection_notified_at'),
```

And widen the `messages.senderRole` column in place:

```ts
  senderRole: text('sender_role', { enum: ['provider', 'patient', 'system'] }).notNull(),
```

- [ ] **Step 5: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/eligibility-notification-schema.test.ts`
Expected: FAIL — now a runtime DB error on the two column tests (`column ... does not exist`), not a TypeScript/property error. The `'system'` message test may already PASS at this point — see Step 6.

- [ ] **Step 6: Write, run, and verify the one-off migration script**

Scratch, not part of the repo. Create `migrate-eligibility-notification-scratch.ts` at this worktree's root:

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  // All three nullable with no default -- an older worktree still inserting
  // into patient_trial_screenings without them keeps working untouched.
  await pool.query(`ALTER TABLE patient_trial_screenings ADD COLUMN IF NOT EXISTS selection_confirmed_at TIMESTAMP`)
  await pool.query(`ALTER TABLE patient_trial_screenings ADD COLUMN IF NOT EXISTS selection_confirmed_by_name TEXT`)
  await pool.query(`ALTER TABLE patient_trial_screenings ADD COLUMN IF NOT EXISTS selection_notified_at TIMESTAMP`)

  // messages.sender_role is a plain TEXT column with a Drizzle-level enum
  // (text('sender_role', { enum: [...] })), not a pg enum -- so widening it
  // to 'system' is expected to need no DDL. Verify that rather than assume it.
  const colType = await pool.query(
    `SELECT data_type, udt_name FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'sender_role'`
  )
  const constraints = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'messages'::regclass`
  )
  console.log('sender_role column:', colType.rows)
  console.log('messages constraints:', constraints.rows)

  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'patient_trial_screenings' ORDER BY column_name`
  )
  console.log('patient_trial_screenings columns:', cols.rows)

  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-eligibility-notification-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Confirm from the printed output that (a) all three new columns exist and are `is_nullable = YES`, and (b) `sender_role` is `text` with **no** CHECK constraint restricting its values. If a CHECK constraint restricting `sender_role` *is* found, it must be widened in the same script (`ALTER TABLE messages DROP CONSTRAINT <name>, ADD CONSTRAINT <name> CHECK (sender_role IN ('provider','patient','system'))`) and the finding called out explicitly in the task report — this is a shared-DB change beyond what this plan predicted.

Delete the scratch script once confirmed: `rm migrate-eligibility-notification-scratch.ts`.

- [ ] **Step 7: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/eligibility-notification-schema.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts tests/db/eligibility-notification-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add selection-confirmation columns and system sender role

EOF
)"
```

---

### Task 2: Query layer — `'system'` message handling, confirm-and-notify, verdict-regression clearing

**Files:**
- Modify: `src/lib/queries/messages.ts` (`SenderRole`, `markReadByPatient`, `getUnreadCountForPatient`)
- Modify: `src/lib/queries/eligibility.ts` (add `confirmScreeningSelection`; extend `regenerateScreeningCriteria`)
- Test: `tests/lib/queries/messages.test.ts` (extend), `tests/lib/queries/eligibility.test.ts` (create — note this file does **not** exist today despite spec §7's "extended"; `tests/lib/eligibility.test.ts` is the unrelated rule-engine test)

**Interfaces:**
- Consumes: Task 1's schema columns; `sendMessage`, `listMessagesForPatient` from `@/lib/queries/messages` (existing); `trials`, `patientTrialScreenings` from `@/db/schema` (existing).
- Produces, from `@/lib/queries/eligibility`:

```ts
export type ConfirmSelectionResult =
  | { ok: true; screeningId: number; confirmedAt: Date; notifiedAt: Date; messageId: number }
  | { ok: false; reason: 'not_found' | 'not_green' | 'already_confirmed' | 'trial_missing' }

export async function confirmScreeningSelection(patientId: string, confirmedByName: string): Promise<ConfirmSelectionResult>
```

  Consumed by Task 3's route. `regenerateScreeningCriteria`'s existing signature and return type are unchanged.
- Produces, from `@/lib/queries/messages`: `SenderRole` widened to `'provider' | 'patient' | 'system'`. Consumed by Task 4.

- [ ] **Step 1: Write the failing tests — messages query layer**

In `tests/lib/queries/messages.test.ts`, widen the existing `seed()` helper's `senderRole` parameter to accept `'system'` (naming a `'system'` sender `'Clinsync (Automated)'`), and add a `describe('system messages', ...)` block asserting, against seeded patients `RD-0001`/`RD-0002` and this file's existing `createdIds` cleanup:

- `getUnreadCountForPatient(PATIENT_A)` counts a `'system'` message the same as a `'provider'` message — seed one of each, assert the count rises by 2.
- `markReadByPatient(PATIENT_A)` sets `readByPatientAt` on a `'system'` message, not just a `'provider'` one.
- `getUnreadCountForProvider()` is unchanged by a `'system'` message — capture the count, seed a `'system'` message, assert the count is identical.
- `markReadByProvider(PATIENT_A)` leaves a `'system'` message's `readByProviderAt` null.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/messages.test.ts`
Expected: FAIL — the unread-count and mark-read assertions for `'system'` (those two functions still filter `senderRole = 'provider'`). The two provider-direction tests should already pass.

- [ ] **Step 3: Widen the message read/unread accounting**

In `src/lib/queries/messages.ts`:
- `export type SenderRole = 'provider' | 'patient' | 'system'`.
- In `markReadByPatient` and `getUnreadCountForPatient`, replace `eq(messages.senderRole, 'provider')` with `inArray(messages.senderRole, ['provider', 'system'])` (`inArray` is already imported in this file). Add a comment: from the patient's side an automated notice is a message from the practice they need to see, so it counts toward their badge and is marked read the same way (spec §5).
- Leave `markReadByProvider`, `getUnreadCountForProvider`, and `listMessageThreads`' `unreadByProviderCount` accounting untouched — a `'system'` message is not something staff need to "read" (spec §5).

- [ ] **Step 4: Run the messages tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/messages.test.ts`
Expected: PASS (existing tests plus the new block).

- [ ] **Step 5: Write the failing tests — confirm and regression clearing**

Create `tests/lib/queries/eligibility.test.ts`. Use seeded patient `RD-0003`, capture its screening row in `beforeEach`, restore `overallStatus` and all three selection columns in `afterEach`, and delete every `messages` row created (query by `patientId` for rows created during the test, tracking ids as they come back from `confirmScreeningSelection`). Tests:

- **confirming a green screening writes all three fields and exactly one system message**: set `overallStatus: 'green'` and all selection columns to null; call `confirmScreeningSelection('RD-0003', 'Dr. Rajiv Kunam')`; assert `result.ok === true`; re-read the screening and assert `selectionConfirmedAt`/`selectionNotifiedAt` are `Date`s and `selectionConfirmedByName === 'Dr. Rajiv Kunam'`; assert `listMessagesForPatient('RD-0003')` gained exactly one row with `senderRole === 'system'`, `senderName === 'Clinsync (Automated)'`, and a `body` containing the real trial's `name` and `site` (looked up from `trials` by the screening's `trialId`) and containing neither `'undefined'` nor `'**'`.
- **the message is not attributed to the confirming clinician** (Review Focus #5): the same created message's `senderName` is `'Clinsync (Automated)'`, not `'Dr. Rajiv Kunam'`.
- **a yellow screening is rejected and writes nothing**: set `overallStatus: 'yellow'`; assert `{ ok: false, reason: 'not_green' }`; assert all three columns are still null and no new message row exists.
- **a red screening is rejected the same way**.
- **an already-confirmed screening is rejected**: confirm once, then call again; assert `{ ok: false, reason: 'already_confirmed' }` and that the message count did not increase.
- **a screening whose trial cannot be resolved aborts before any write** (Review Focus #3): set `overallStatus: 'green'`, all selection columns null, and temporarily point `trialId` at a nonexistent id (restore it in `afterEach` alongside the other fields); assert `{ ok: false, reason: 'trial_missing' }`, that all three selection columns are still null, and that no new message row exists.
- **a patient with no screening at all**: `confirmScreeningSelection('RD-9999-nonexistent', 'X')` returns `{ ok: false, reason: 'not_found' }`.
- **two concurrent confirms produce exactly one message** (Review Focus #2): set up a fresh green, unconfirmed screening; `await Promise.all([confirmScreeningSelection(...), confirmScreeningSelection(...)])`; assert exactly one result has `ok === true`, the other is `{ ok: false, reason: 'already_confirmed' }`, and exactly one `'system'` message row was added.
- **regenerating a confirmed screening that flips away from green clears the confirmation but not the notification**: confirm a green screening, then force the underlying verdict away from green and call `regenerateScreeningCriteria('RD-0003', screening.id, screening.trialId)`; assert the returned verdict is not `'green'`, `selectionConfirmedAt` and `selectionConfirmedByName` are now null, and `selectionNotifiedAt` is still set. (To force a non-green re-evaluation without touching the rule engine, point the screening at a trial the patient cannot pass — e.g. the ADHD trial `nct-adhd-demo-01` for an MDD-diagnosed patient — and restore `trialId` in `afterEach`. If that does not reliably yield a non-green verdict for the chosen patient, pick a different seeded patient/trial pairing rather than modifying `evaluateCriteria`.)
- **regenerating a confirmed screening that stays green leaves the confirmation intact**: confirm, then re-run `regenerateScreeningCriteria` against the screening's own trial; if the verdict is still `'green'`, assert `selectionConfirmedAt`/`selectionConfirmedByName` are unchanged.
- **re-confirming after a regression back to green sends a second, independent notification** (Review Focus #1): confirm once (message count +1), clear `selectionConfirmedAt`/`selectionConfirmedByName` while leaving `selectionNotifiedAt` set (exactly the state the regression leaves behind), set `overallStatus` back to `'green'`, and confirm again; assert `ok === true` and that a **second** `'system'` message now exists, and that `selectionNotifiedAt` advanced past its previous value.

- [ ] **Step 6: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/eligibility.test.ts`
Expected: FAIL — `confirmScreeningSelection` is not exported.

- [ ] **Step 7: Implement `confirmScreeningSelection` in `src/lib/queries/eligibility.ts`**

Signature exactly as given in this task's Interfaces block. The ordering is load-bearing and is the whole of Review Focus #1, #2 and #3, so implement it as written:

```ts
export async function confirmScreeningSelection(patientId: string, confirmedByName: string): Promise<ConfirmSelectionResult> {
  const db = getDb()
  const [screening] = await db.select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, patientId))
  if (!screening) return { ok: false, reason: 'not_found' }
  if (screening.overallStatus !== 'green') return { ok: false, reason: 'not_green' }

  // Resolve the trial BEFORE claiming the confirmation. The message
  // interpolates the real trial's name/site (spec §5); an unresolvable
  // trial must abort with nothing written rather than send the patient
  // "selected to move forward with undefined at undefined".
  const [trial] = await db.select().from(trials).where(eq(trials.id, screening.trialId))
  if (!trial) return { ok: false, reason: 'trial_missing' }

  // Single conditional UPDATE, same conditional-transition-guard posture as
  // administerMedication / confirmBookingRequest: only one of two racing
  // callers can win this, and only the winner goes on to notify.
  const confirmedAt = new Date()
  const claimed = await db.update(patientTrialScreenings)
    .set({ selectionConfirmedAt: confirmedAt, selectionConfirmedByName: confirmedByName })
    .where(and(
      eq(patientTrialScreenings.id, screening.id),
      eq(patientTrialScreenings.overallStatus, 'green'),
      isNull(patientTrialScreenings.selectionConfirmedAt),
    ))
    .returning({ id: patientTrialScreenings.id })
  if (claimed.length === 0) return { ok: false, reason: 'already_confirmed' }

  // The send-guard (spec §4), claimed the same conditional way. It is NOT a
  // bare `selection_notified_at IS NULL` check: selectionNotifiedAt is the
  // one field never cleared by a verdict regression (spec §3), so a bare
  // NULL check would permanently swallow the legitimate second notification
  // after a reconfirmation. "Not yet notified FOR THIS confirmation" is the
  // real invariant, and on a first confirmation it reduces to the NULL check.
  const notifiedAt = new Date()
  const claimedNotify = await db.update(patientTrialScreenings)
    .set({ selectionNotifiedAt: notifiedAt })
    .where(and(
      eq(patientTrialScreenings.id, screening.id),
      or(
        isNull(patientTrialScreenings.selectionNotifiedAt),
        lt(patientTrialScreenings.selectionNotifiedAt, patientTrialScreenings.selectionConfirmedAt),
      ),
    ))
    .returning({ id: patientTrialScreenings.id })
  if (claimedNotify.length === 0) return { ok: false, reason: 'already_confirmed' }

  const created = await sendMessage(patientId, 'system', SYSTEM_SENDER_NAME, selectionNotificationBody(trial.name, trial.site))
  return { ok: true, screeningId: screening.id, confirmedAt, notifiedAt, messageId: created.id }
}
```

Add alongside it, in the same file, the two constants the template is made of — this is the fixed, pre-vetted copy from Global Constraints, exported so Task 3's and Task 4's verification can reference it rather than retyping it:

```ts
export const SYSTEM_SENDER_NAME = 'Clinsync (Automated)'

export function selectionNotificationBody(trialName: string, trialSite: string): string {
  return `Great news — based on your recent screening, you've been selected to move forward with ${trialName} at ${trialSite}. A member of our care team will reach out soon to schedule your next steps.`
}
```

Add the needed imports to this file: `and`, `isNull`, `or`, `lt` from `drizzle-orm`, and `sendMessage` from `@/lib/queries/messages`.

- [ ] **Step 8: Extend `regenerateScreeningCriteria` with the verdict-regression clearing**

In the same file, in `regenerateScreeningCriteria`, replace the existing single `update(patientTrialScreenings).set({ overallStatus })` with a set that also clears the confirmation when the new verdict is not `'green'`:

```ts
  // A confirmation was a human's judgment about the evidence at that moment
  // (spec §3). Once the chart data changes enough to flip the computed
  // verdict away from green, that judgment has no factual basis and must be
  // re-made. selectionNotifiedAt is deliberately NOT cleared -- the patient
  // really was notified once, and that historical fact doesn't un-happen.
  await db.update(patientTrialScreenings)
    .set(overallStatus === 'green'
      ? { overallStatus }
      : { overallStatus, selectionConfirmedAt: null, selectionConfirmedByName: null })
    .where(eq(patientTrialScreenings.id, screeningId))
```

This covers both existing callers (`POST /api/patients/[anonId]/refresh` and `src/lib/auto-classify.ts`) without touching either — the clearing lives in the one shared evaluation path, not in each caller.

- [ ] **Step 9: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/eligibility.test.ts tests/lib/queries/messages.test.ts tests/lib/auto-classify.test.ts`
Expected: PASS. (`auto-classify.test.ts` is included because it exercises the other caller of the function changed in Step 8.)

- [ ] **Step 10: Commit**

```bash
git add src/lib/queries/eligibility.ts src/lib/queries/messages.ts tests/lib/queries/eligibility.test.ts tests/lib/queries/messages.test.ts
git commit -m "$(cat <<'EOF'
feat: add confirmScreeningSelection and system-message read accounting

EOF
)"
```

---

### Task 3: Confirm route + Patient Detail action

**Files:**
- Create: `src/app/api/patients/[anonId]/screening/confirm/route.ts`
- Create: `src/components/ConfirmEligibilityButton.tsx`
- Modify: `src/lib/queries/patients.ts` (`getPatientDetail` projection)
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx` (header row, next to `StatusChip`/`RefreshEligibilityButton`)
- Modify: `src/lib/role-capabilities.ts`
- Test: `tests/api/patients-screening-confirm.test.ts`

**Interfaces:**
- Consumes: `confirmScreeningSelection`, `ConfirmSelectionResult` from `@/lib/queries/eligibility` (Task 2); `requireSession` from `@/lib/auth`, `logAudit` from `@/lib/audit`, `invalidateCache`/`patientDetailCacheKey` from `@/lib/cache` (all existing).
- Produces: `POST /api/patients/[anonId]/screening/confirm`; `getPatientDetail` gains `selectionConfirmedAt`, `selectionConfirmedByName`, `selectionNotifiedAt` on its returned object. Both consumed by Task 4's verification.

- [ ] **Step 1: Write the failing test**

Create `tests/api/patients-screening-confirm.test.ts`, mocking `requireSession` with the `vi.mock('@/lib/auth', ...)` pattern already used in `tests/api/messages.test.ts` / `tests/api/pharmacy-dispense.test.ts`. Use seeded patient `RD-0003`; capture and restore its screening row and delete created messages the same way Task 2's test does. Tests:

- `admin`, `pi`, and `crc` sessions each get 200 on a green, unconfirmed screening (reset the screening state between them).
- a `frontdesk` session gets **403**, and — asserted explicitly — the screening's three selection columns are still null and no message row was created (Review Focus: the button is hidden for frontdesk, so this route check is the only real gate).
- no session (mock `requireSession` to return a 401 `NextResponse`) → 401.
- a patient with no screening row at all → 404.
- a `yellow` screening → 409, and nothing written.
- an already-confirmed screening → 409, and **explicitly** that this second call produced no second message row.
- success path: response body carries `ok: true`; the DB row has all three columns set with `selectionConfirmedByName` equal to the mocked session's `name`; and exactly one `'system'` message exists for that patient afterward, its `body` containing the real trial's name and site.

```ts
function req() {
  return new Request('http://localhost/api/patients/RD-0003/screening/confirm', { method: 'POST' })
}
// e.g.
const res = await POST(req() as never, { params: Promise.resolve({ anonId: 'RD-0003' }) })
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-screening-confirm.test.ts`
Expected: FAIL — route module doesn't exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/patients/[anonId]/screening/confirm/route.ts`, modelled on the sibling `POST /api/patients/[anonId]/refresh` (same bodyless shape, same cache invalidation, same audit call). `requireSession()` first; then the role gate `if (!['admin', 'pi', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })` with a comment naming why `frontdesk` is excluded (spec §9: a logistics/registration role, not the tier that owns a trial-eligibility judgment). No Zod schema and no `request.json()` call — this route takes no body.

Map `confirmScreeningSelection(anonId, session.name)`'s result to responses:

| result | response |
|---|---|
| `reason: 'not_found'` | 404 `{ error: 'Not found' }` |
| `reason: 'not_green'` | 409 `{ error: 'Cannot confirm — screening is not currently green' }` |
| `reason: 'already_confirmed'` | 409 `{ error: 'Already confirmed' }` |
| `reason: 'trial_missing'` | 409 `{ error: 'Cannot confirm — this screening\'s trial could not be resolved' }` |
| `ok: true` | 200 `{ ok: true, confirmedAt, notifiedAt }` |

On success only, `await invalidateCache(patientDetailCacheKey(anonId))` then `await logAudit(session, 'confirmed trial eligibility and notified patient', anonId)`.

- [ ] **Step 4: Run the route test to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-screening-confirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Surface the three fields on the patient detail projection**

In `src/lib/queries/patients.ts`, `getPatientDetail` already reads the whole `screening` row but projects only `overallStatus: screening?.overallStatus`. Add, next to it, `selectionConfirmedAt: screening?.selectionConfirmedAt ?? null`, `selectionConfirmedByName: screening?.selectionConfirmedByName ?? null`, `selectionNotifiedAt: screening?.selectionNotifiedAt ?? null` — preserving the file's deliberate explicit-projection discipline (see the comment there about never putting `idNumberEncrypted` on the wire or in the Redis cache).

- [ ] **Step 6: Build the button component**

Create `src/components/ConfirmEligibilityButton.tsx` (`'use client'`), taking `{ anonId }: { anonId: string }`. Follow `RefreshEligibilityButton.tsx` exactly: local `running`/`error` state, `POST` to `/api/patients/${anonId}/screening/confirm` with no body, `window.location.reload()` on success (same comment/reason as that component: this page's data comes from a Redis-cached query and only reliably refreshes on a real navigation), inline `text-xs text-destructive` error otherwise. Surface the route's own error message when the response carries one (a 409 says *why*), falling back to `'Could not confirm eligibility.'`. Label: `Confirm Eligibility & Notify Patient`, `Confirming…` while running. Same visual weight as `RefreshEligibilityButton`'s classes.

- [ ] **Step 7: Wire it into the Patient Detail header row**

In `src/app/(dashboard)/patients/[anonId]/page.tsx`, in the header `<div className="flex items-center gap-3">` that already holds `DeletePatientButton`, `RefreshEligibilityButton`, and `StatusChip`, add — between the refresh button and the status chip — the three-way render from spec §6:

- `patient.selectionConfirmedAt` set → a small line (`text-xs text-muted-foreground`, with a `text-success` dot in the style the Identity Verification block already uses): `Eligibility confirmed by {patient.selectionConfirmedByName} on {date} — patient notified {notified date}.` (both via `new Date(...).toLocaleDateString()`).
- else `patient.overallStatus === 'green'` **and** `['admin', 'pi', 'crc'].includes(session.role)` → `<ConfirmEligibilityButton anonId={patient.id} />`. The role check mirrors the route's gate (spec §9) so the button never renders for `frontdesk`, matching how this page already gates by role (`canManageMedications={['pi', 'admin'].includes(session.role)}`); the route's 403 remains the real enforcement.
- else → nothing.

- [ ] **Step 8: Add the role-capability bullets**

In `src/lib/role-capabilities.ts`, add `'Confirm a green trial-eligibility verdict, which automatically notifies the patient'` to the `bullets` array of `admin`, `pi`, and `crc`. Do not add it to `frontdesk`.

- [ ] **Step 9: Run this task's tests to confirm they still pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-screening-confirm.test.ts tests/lib/queries/eligibility.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add "src/app/api/patients/[anonId]/screening" src/components/ConfirmEligibilityButton.tsx src/lib/queries/patients.ts "src/app/(dashboard)/patients/[anonId]/page.tsx" src/lib/role-capabilities.ts tests/api/patients-screening-confirm.test.ts
git commit -m "$(cat <<'EOF'
feat: add Confirm Eligibility action and route

EOF
)"
```

---

### Task 4: System-message rendering treatment + end-to-end verification

**Files:**
- Modify: `src/components/MessageThreadView.tsx`
- Modify: `src/app/(dashboard)/messages/page.tsx` (thread-list preview prefix)
- Test: none new — this is UI wiring over already-tested query and route layers; verified per Global Constraints' UI verification discipline.

**Interfaces:**
- Consumes: `SenderRole` from `@/lib/queries/messages` (Task 2); `POST /api/patients/[anonId]/screening/confirm` (Task 3, called by URL); `SYSTEM_SENDER_NAME` / `selectionNotificationBody` from `@/lib/queries/eligibility` (Task 2) as the reference copy to check the rendered output against.

- [ ] **Step 1: Widen `MessageRow` and add the `'system'` branch**

In `src/components/MessageThreadView.tsx`:

- Widen `MessageRow.senderRole` to `'provider' | 'patient' | 'system'`. This is the compile-time forcing function: once Task 1's schema widened, both call sites (`(dashboard)/messages/page.tsx` and `patient-portal/(authenticated)/messages/page.tsx`) pass rows whose `senderRole` is the wider union, so the component must accept it. Do **not** narrow it back at either call site.
- Branch on `m.senderRole === 'system'` **before** the existing `const isOwn = m.senderRole === viewerRole` comparison (Review Focus #4 — that comparison is false for `'system'` on both surfaces, which would left-align an automated notice as "the other party"). The `'system'` branch renders a centered, full-width banner rather than a left/right chat bubble, in the visual language already present in this file and the rest of the app (no new design tokens):
  - container: full width (no `max-w-[80%]`, no `ml-auto`), `text-center`, a bordered muted panel in the same `rounded-lg`/`border`/`bg-secondary` family the bubbles already use, with `role="status"` for a11y.
  - a label line reading exactly **`AUTOMATED NOTICE`**, in the *same* small-caps treatment this file already uses for sender names: `text-[11px] font-semibold uppercase tracking-wide text-muted-foreground`.
  - the message body, `whitespace-pre-wrap`, same as the bubble branch.
  - a fixed italic line beneath the body, exactly: *`This is an automated note, not a reply from your care team.`*
  - the timestamp, in the same `mt-1 text-[10px] text-muted-foreground` treatment as the bubble branch.
- Keep the existing bubble rendering for `'provider'`/`'patient'` byte-for-byte unchanged.
- Update the component's doc comment: `viewerRole` still decides which side of the thread reads as "you", and a `'system'` message belongs to neither side on either surface.

- [ ] **Step 2: Fix the thread-list preview prefix**

In `src/app/(dashboard)/messages/page.tsx`, the conversation-list preview renders `${t.lastMessagePreview.senderRole === 'provider' ? 'You: ' : ''}${...body}`, so a `'system'` message currently previews unprefixed — i.e. exactly as a patient-authored message does, in the one list a staff member scans to triage replies. Add a third case so a `'system'` preview reads `Automated: ` instead.

- [ ] **Step 3: Verify the full flow via a real running dev server, not narration**

Start the dev server on a free port (e.g. `npx next dev -p <port>`, backgrounded).

Staff side: mint a `clinsync_demo_session` cookie for an `admin` (or `pi`) session per Global Constraints. Pick a patient whose screening you have driven to `green` and left unconfirmed (set it directly via a small `pg` script if no seeded patient is currently green — restore it afterward). Real `GET` of `/patients/<anonId>`, confirm the "Confirm Eligibility & Notify Patient" button renders. Real `POST` to `/api/patients/<anonId>/screening/confirm` with that cookie, confirm 200. Real `GET` of `/patients/<anonId>` again, confirm the button is gone and the "Eligibility confirmed by … — patient notified …" line renders instead. Real `GET` of `/messages?patientId=<anonId>`, confirm the response HTML contains `AUTOMATED NOTICE`, the real trial name and site, the italic disclaimer line, and the `Automated: ` preview in the conversation list.

Negative case: mint a `frontdesk` session cookie and `POST` the same route; confirm 403 and that the screening row is unchanged.

Patient side: mint a `clinsync_patient_session` cookie (`kind: 'patient'`) for that same patient per Global Constraints. Real `GET` of `/patient-portal/messages`, confirm the banner renders there too (`AUTOMATED NOTICE`, the disclaimer line) and is **not** right-aligned as the patient's own message. Confirm the portal's unread-message badge counted the notice before that page marked it read.

Paste every actual command and its actual output. Stop the dev server when done, and restore any screening row you mutated by hand.

- [ ] **Step 4: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageThreadView.tsx "src/app/(dashboard)/messages/page.tsx"
git commit -m "$(cat <<'EOF'
feat: render system-generated messages as an automated-notice banner

EOF
)"
```
