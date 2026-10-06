# Patient-Portal Security (TOTP MFA + Patient Auto-Logoff) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mandatory TOTP MFA to staff login, optional opt-in TOTP MFA to patient-portal login, three lost-device recovery paths (self-service password re-auth for staff/patients, admin-triggered reset for either), and a patient-portal idle-logoff warning that mirrors the existing staff one.

**Architecture:** Two-step login for both staff and patients, bridged by a short-lived signed "pending" JWT cookie (mirrors the existing `jose`/`SESSION_SECRET` session cookies, just shorter-lived and separately named). TOTP secrets are generated/validated by a small `otpauth`-based library, encrypted at rest with the existing AES-256-GCM helper, and never leave the server except as a one-time QR/manual-key pair during enrollment. Admin's MFA state lives on the `appSettings` singleton row (it has no `users` row — see the spec). Reset is uniform everywhere: clear the secret + enabled flag, which forces re-enrollment next time.

**Tech Stack:** Next.js API routes, Drizzle ORM / Neon Postgres, `jose` (existing), `otpauth` (new), `qrcode` (new), `@upstash/ratelimit` (existing), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-patient-portal-security-mfa-design.md`

## Global Constraints

- No existing credential changes: admin env vars (`ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`), `users.passwordHash`, `patients.portalPasswordHash`, `SESSION_SECRET`, `IDENTITY_ENCRYPTION_KEY` are never touched, rotated, or migrated by this work.
- Schema changes are additive-only, applied via a hand-written throwaway SQL script (never `drizzle-kit push` against the shared dev database) — this project's standing rule, `docs/ehr-platform-architecture.md:83`.
- TOTP only. No `mfaMethod` column — one method exists, so there's nothing to select between yet.
- MFA secrets are stored encrypted via the existing `encryptSensitive`/`decryptSensitive` (`src/lib/crypto.ts`, AES-256-GCM) — the same helper already protecting ID numbers. No new crypto.
- Pending-login JWTs are separate cookies from the real session cookies (`clinsync_pending_staff_mfa` / `clinsync_pending_patient_mfa`), 5-minute expiry, `httpOnly`, same `jose`/`SESSION_SECRET` signing as `src/lib/auth.ts` and `src/lib/patient-session.ts`.
- Every error response for a credential/code check is generic ("Invalid email or password", "Invalid code") — never confirms which part was wrong, matching the existing login route's own philosophy.
- Every route touching PHI-shaped data calls `requireSession()`/`requirePatientSession()` (or the admin-only role check) before any DB work, matching `src/lib/auth.ts`'s documented convention.
- Every MFA state change (enroll, verify-login, reset — self or admin-triggered) writes an audit entry via `logAudit()` (staff) or `logPatientPortalAction()` (patient) — no unattributed write path, matching this codebase's audit-log discipline.
- Test files: `// @vitest-environment node` at the top of any test touching `jose`/cookies (see `tests/api/login.test.ts`'s comment for why). Mock `@/lib/rate-limit` in route tests rather than hitting real Redis, matching `tests/api/login.test.ts`. Tests share one live dev database — create rows with a clearly-marked test identifier and delete them in `afterAll`, matching `tests/api/login.test.ts`'s `TEST_DB_USER_EMAIL` pattern.

## Review Focus

- **Patient without MFA enabled logs in exactly as before.** This is the highest-traffic path through code this plan edits (`POST /api/patient-portal/login`) — a regression here breaks every patient, not just MFA users. Test: existing non-MFA patient login still returns `{ok:true}` and sets the real session cookie directly, no `mfaRequired` in the response.
- **Missing or expired pending cookie hitting a step-2 route.** A user who waits past 5 minutes, or opens the code-entry screen in a second tab with no cookie, must get a clean "session expired, sign in again" 401 — never a crash or a 500 from a null dereference. Test: call `/api/login/mfa` and `/api/patient-portal/login/mfa` with no pending cookie set.
- **TOTP clock-drift window boundary.** `window: 1` should accept a code from the immediately preceding 30s period but reject one from two periods ago. Test both sides of that boundary directly against `verifyMfaCode`.
- **Rate-limited MFA verify attempts.** Repeated wrong codes must 429, not silently allow unlimited guessing against a 6-digit space. Test the mocked rate limiter's `allowed: false` path returns 429 before any code is even checked.
- **Self-service reset rejecting a credential that's valid but belongs to someone else's account.** The endpoint re-verifies a password, but must also confirm the resulting identity matches the *caller's own* session (role+name) — otherwise a signed-in low-privilege session could reset a different account's MFA by supplying that account's own email+password (which the attacker would need to already know — this is a defense-in-depth check, not the primary guard, but it must exist). Test: a signed-in `pi` session submitting valid `admin` credentials to `/api/account/mfa/reset` is rejected.

---

### Task 1: Schema — add MFA columns via throwaway script

**Files:**
- Modify: `src/db/schema.ts:156-166` (`users` table), `src/db/schema.ts:40-90` (`patients` table), `src/db/schema.ts:354-370` (`appSettings` table)
- Create (temporary, deleted before commit): `scripts/add-mfa-columns.ts`

**Interfaces:**
- Produces: `users.mfaSecretEncrypted: string | null`, `users.mfaEnabled: boolean`; `patients.mfaSecretEncrypted: string | null`, `patients.mfaEnabled: boolean`; `appSettings.adminMfaSecretEncrypted: string | null`, `appSettings.adminMfaEnabled: boolean`.

- [ ] **Step 1: Write the throwaway migration script**

```ts
// scripts/add-mfa-columns.ts -- run once, then delete. Hand-written additive
// SQL against the shared dev database, per this project's standing rule
// (never drizzle-kit push here -- see docs/ehr-platform-architecture.md).
import { sql } from 'drizzle-orm'
import { getDb } from '../src/db/client'

async function main() {
  const db = getDb()
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_encrypted text`)
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false`)
  await db.execute(sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS mfa_secret_encrypted text`)
  await db.execute(sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false`)
  await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_mfa_secret_encrypted text`)
  await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_mfa_enabled boolean NOT NULL DEFAULT false`)
  console.log('MFA columns added.')
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Run it against the dev database**

Run: `npx dotenv -e .env.local -- tsx scripts/add-mfa-columns.ts`
Expected: prints `MFA columns added.` with no error.

- [ ] **Step 3: Verify the columns exist**

Run: `npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { sql } from 'drizzle-orm'; getDb().execute(sql\`select mfa_enabled from users limit 1\`).then(() => getDb().execute(sql\`select mfa_enabled from patients limit 1\`)).then(() => getDb().execute(sql\`select admin_mfa_enabled from app_settings limit 1\`)).then(() => { console.log('OK'); process.exit(0) })"`
Expected: prints `OK` with no error (a missing column would throw a Postgres error here instead).

- [ ] **Step 4: Add the matching fields to `schema.ts`**

In the `users` table (after `passwordHash`):
```ts
  passwordHash: text('password_hash'),
  mfaSecretEncrypted: text('mfa_secret_encrypted'),
  mfaEnabled: boolean('mfa_enabled').default(false).notNull(),
})
```

In the `patients` table (after `chartDataAsOf`):
```ts
  chartDataAsOf: timestamp('chart_data_as_of').defaultNow().notNull(),
  mfaSecretEncrypted: text('mfa_secret_encrypted'),
  mfaEnabled: boolean('mfa_enabled').default(false).notNull(),
})
```

In the `appSettings` table (after `tebraPasswordEncrypted`):
```ts
  tebraPasswordEncrypted: text('tebra_password_encrypted'),
  // The admin account authenticates via ADMIN_EMAIL/ADMIN_PASSWORD_HASH env
  // vars (api/login/route.ts), not a users row -- its MFA state has nowhere
  // else to live, so it goes on this pilot-wide singleton instead.
  adminMfaSecretEncrypted: text('admin_mfa_secret_encrypted'),
  adminMfaEnabled: boolean('admin_mfa_enabled').default(false).notNull(),
})
```

- [ ] **Step 5: Delete the throwaway script**

Run: `rm scripts/add-mfa-columns.ts` (remove the `scripts/` directory too if now empty)

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: add MFA columns to users, patients, and app_settings"
```

---

### Task 2: MFA TOTP core library

**Files:**
- Create: `src/lib/mfa.ts`
- Test: `tests/lib/mfa.test.ts`
- Modify: `package.json` (add `otpauth`, `qrcode`, `@types/qrcode`)

**Interfaces:**
- Produces: `generateMfaEnrollment(accountLabel: string): Promise<{ secretBase32: string; qrDataUrl: string }>`, `verifyMfaCode(secretBase32: string, code: string): boolean`. Both are pure functions over plaintext base32 secrets — callers (Task 4's data-access helpers) are responsible for encrypting/decrypting with `lib/crypto.ts` before/after storage.

- [ ] **Step 1: Install dependencies**

Run: `npm install otpauth@9.5.2 qrcode@1.5.4 && npm install -D @types/qrcode@1.5.6`

- [ ] **Step 2: Write the failing test**

```ts
// tests/lib/mfa.test.ts
import { describe, it, expect } from 'vitest'
import * as OTPAuth from 'otpauth'
import { generateMfaEnrollment, verifyMfaCode } from '@/lib/mfa'

describe('generateMfaEnrollment', () => {
  it('returns a base32 secret and a scannable QR data URL', async () => {
    const enrollment = await generateMfaEnrollment('test@example.com')
    expect(enrollment.secretBase32).toMatch(/^[A-Z2-7]+=*$/)
    expect(enrollment.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  })
})

describe('verifyMfaCode', () => {
  it('accepts the current valid code', () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    const totp = new OTPAuth.TOTP({ issuer: 'Clinsync', label: 'test', algorithm: 'SHA1', digits: 6, period: 30, secret })
    expect(verifyMfaCode(secret.base32, totp.generate())).toBe(true)
  })

  it('rejects a wrong code', () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    expect(verifyMfaCode(secret.base32, '000000')).toBe(false)
  })

  it('accepts a code from one period ago (clock-drift tolerance)', () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    const totp = new OTPAuth.TOTP({ issuer: 'Clinsync', label: 'test', algorithm: 'SHA1', digits: 6, period: 30, secret })
    const oneStepAgo = totp.generate({ timestamp: Date.now() - 30_000 })
    expect(verifyMfaCode(secret.base32, oneStepAgo)).toBe(true)
  })

  it('rejects a code from two periods ago (outside the drift window)', () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    const totp = new OTPAuth.TOTP({ issuer: 'Clinsync', label: 'test', algorithm: 'SHA1', digits: 6, period: 30, secret })
    const twoStepsAgo = totp.generate({ timestamp: Date.now() - 60_000 })
    expect(verifyMfaCode(secret.base32, twoStepsAgo)).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/lib/mfa.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mfa'`

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/mfa.ts
import * as OTPAuth from 'otpauth'
import QRCode from 'qrcode'

const ISSUER = 'Clinsync'

export interface MfaEnrollment {
  secretBase32: string
  qrDataUrl: string
}

// Generates a fresh TOTP secret and a scannable QR code for it. Returns the
// secret in plaintext base32 -- callers are responsible for encrypting it
// with lib/crypto.ts before it ever reaches a database row; this module
// never touches storage.
export async function generateMfaEnrollment(accountLabel: string): Promise<MfaEnrollment> {
  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: accountLabel, algorithm: 'SHA1', digits: 6, period: 30, secret })
  const qrDataUrl = await QRCode.toDataURL(totp.toString())
  return { secretBase32: secret.base32, qrDataUrl }
}

// window: 1 tolerates the code from the immediately preceding or following
// 30s period, absorbing normal clock drift between the server and the
// authenticator app without meaningfully widening the guessable window.
export function verifyMfaCode(secretBase32: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: 'verify', algorithm: 'SHA1', digits: 6, period: 30, secret: secretBase32 })
  return totp.validate({ token: code, window: 1 }) !== null
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/lib/mfa.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/mfa.ts tests/lib/mfa.test.ts
git commit -m "feat: add TOTP secret generation and code verification helpers"
```

---

### Task 3: Pending-login MFA session cookies

**Files:**
- Create: `src/lib/mfa-pending-session.ts`
- Test: `tests/lib/mfa-pending-session.test.ts`

**Interfaces:**
- Consumes: nothing new (mirrors `src/lib/patient-session.ts`'s `cookies()`/`SignJWT`/`jwtVerify` pattern).
- Produces: `setPendingStaffMfaCookie({role, name, mode, userId}): Promise<void>`, `getPendingStaffMfaSession(): Promise<{role: Role; name: string; mode: 'enroll'|'verify'; userId: number|null} | null>`, `clearPendingStaffMfaCookie(): Promise<void>`, `setPendingPatientMfaCookie({patientId}): Promise<void>`, `getPendingPatientMfaSession(): Promise<{patientId: string} | null>`, `clearPendingPatientMfaCookie(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/mfa-pending-session.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  setPendingStaffMfaCookie, getPendingStaffMfaSession, clearPendingStaffMfaCookie,
  setPendingPatientMfaCookie, getPendingPatientMfaSession, clearPendingPatientMfaCookie,
} from '@/lib/mfa-pending-session'

// next/headers' cookies() needs a request-scoped store; fake one in-memory
// so these can run as plain unit tests, same reasoning as vitest.setup.ts's
// existing next/headers mock but with a real settable store instead of a
// no-op one, since these tests need to read back what they set.
const store = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
    set: (name: string, value: string) => { store.set(name, value) },
    delete: (name: string) => { store.delete(name) },
  }),
}))

beforeAll(() => { vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes-long') })
afterAll(() => { vi.unstubAllEnvs() })

describe('pending staff MFA session', () => {
  it('round-trips an enroll-mode session for the env admin account', async () => {
    await setPendingStaffMfaCookie({ role: 'admin', name: 'Test Admin', mode: 'enroll', userId: null })
    const session = await getPendingStaffMfaSession()
    expect(session).toEqual({ role: 'admin', name: 'Test Admin', mode: 'enroll', userId: null })
  })

  it('round-trips a verify-mode session for a DB-backed user', async () => {
    await setPendingStaffMfaCookie({ role: 'crc', name: 'Test CRC', mode: 'verify', userId: 42 })
    const session = await getPendingStaffMfaSession()
    expect(session).toEqual({ role: 'crc', name: 'Test CRC', mode: 'verify', userId: 42 })
  })

  it('returns null after clearing', async () => {
    await setPendingStaffMfaCookie({ role: 'admin', name: 'Test Admin', mode: 'verify', userId: null })
    await clearPendingStaffMfaCookie()
    expect(await getPendingStaffMfaSession()).toBeNull()
  })

  it('returns null with no cookie set', async () => {
    await clearPendingStaffMfaCookie()
    expect(await getPendingStaffMfaSession()).toBeNull()
  })
})

describe('pending patient MFA session', () => {
  it('round-trips a patient session', async () => {
    await setPendingPatientMfaCookie({ patientId: 'RD-0001' })
    expect(await getPendingPatientMfaSession()).toEqual({ patientId: 'RD-0001' })
  })

  it('returns null after clearing', async () => {
    await setPendingPatientMfaCookie({ patientId: 'RD-0001' })
    await clearPendingPatientMfaCookie()
    expect(await getPendingPatientMfaSession()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/lib/mfa-pending-session.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mfa-pending-session'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/mfa-pending-session.ts
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import type { Role } from './auth'

// Bridges the two-step MFA login flow: step 1 (password check) mints one of
// these; step 2 (code check) reads it to know whose login is mid-flight and
// whether this is a first-time enrollment or a returning verify. Separate
// cookie names and a `kind` claim keep these from ever being confused with
// the real, fully-authenticated session cookies in auth.ts/patient-session.ts,
// even though all three share the same SESSION_SECRET and jose signing setup.
const STAFF_COOKIE_NAME = 'clinsync_pending_staff_mfa'
const PATIENT_COOKIE_NAME = 'clinsync_pending_patient_mfa'
const PENDING_MAX_AGE_SECONDS = 5 * 60 // long enough to scan a QR code and type a 6-digit code, short enough that an abandoned mid-login state can't be resumed much later

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not configured')
  return new TextEncoder().encode(secret)
}

export interface PendingStaffMfaSession {
  role: Role
  name: string
  mode: 'enroll' | 'verify'
  userId: number | null // null = the env-based admin account
}

export async function setPendingStaffMfaCookie(session: PendingStaffMfaSession): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-staff-mfa', role: session.role, name: session.name, mode: session.mode, userId: session.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(STAFF_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: PENDING_MAX_AGE_SECONDS })
}

export async function getPendingStaffMfaSession(): Promise<PendingStaffMfaSession | null> {
  const store = await cookies()
  const raw = store.get(STAFF_COOKIE_NAME)?.value
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, getSessionSecret())
    if (
      payload.kind === 'pending-staff-mfa' &&
      typeof payload.name === 'string' &&
      (payload.mode === 'enroll' || payload.mode === 'verify') &&
      (payload.userId === null || typeof payload.userId === 'number')
    ) {
      return { role: payload.role as Role, name: payload.name, mode: payload.mode, userId: payload.userId as number | null }
    }
    return null
  } catch {
    return null
  }
}

export async function clearPendingStaffMfaCookie(): Promise<void> {
  const store = await cookies()
  store.delete(STAFF_COOKIE_NAME)
}

export interface PendingPatientMfaSession {
  patientId: string
}

export async function setPendingPatientMfaCookie(session: PendingPatientMfaSession): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-patient-mfa', patientId: session.patientId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(PATIENT_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: PENDING_MAX_AGE_SECONDS })
}

export async function getPendingPatientMfaSession(): Promise<PendingPatientMfaSession | null> {
  const store = await cookies()
  const raw = store.get(PATIENT_COOKIE_NAME)?.value
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, getSessionSecret())
    if (payload.kind === 'pending-patient-mfa' && typeof payload.patientId === 'string' && payload.patientId.length > 0) {
      return { patientId: payload.patientId }
    }
    return null
  } catch {
    return null
  }
}

export async function clearPendingPatientMfaCookie(): Promise<void> {
  const store = await cookies()
  store.delete(PATIENT_COOKIE_NAME)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/lib/mfa-pending-session.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mfa-pending-session.ts tests/lib/mfa-pending-session.test.ts
git commit -m "feat: add short-lived pending-MFA session cookies for two-step login"
```

---

### Task 4: MFA data-access helpers (users, patients, appSettings)

**Files:**
- Modify: `src/lib/queries/users.ts`
- Modify: `src/lib/queries/patient-portal.ts`
- Modify: `src/lib/queries/settings.ts`
- Test: `tests/lib/queries/mfa-state.test.ts`

**Interfaces:**
- Consumes: `patients`/`users`/`appSettings` schema fields from Task 1.
- Produces:
  - `getUserMfaState(userId: number): Promise<{mfaSecretEncrypted: string|null; mfaEnabled: boolean} | null>`
  - `getUserNameById(userId: number): Promise<string | null>`
  - `setUserMfaSecret(userId: number, secretEncrypted: string): Promise<void>`
  - `enableUserMfa(userId: number): Promise<void>`
  - `resetUserMfa(userId: number): Promise<void>`
  - `listAllUsers()` now also selects `mfaEnabled`
  - `getPatientMfaState(patientId: string): Promise<{mfaSecretEncrypted: string|null; mfaEnabled: boolean} | null>`
  - `setPatientMfaSecret(patientId: string, secretEncrypted: string): Promise<void>`
  - `enablePatientMfa(patientId: string): Promise<void>`
  - `resetPatientMfa(patientId: string): Promise<void>`
  - `getAdminMfaState(): Promise<{mfaSecretEncrypted: string|null; mfaEnabled: boolean}>`
  - `setAdminMfaSecret(secretEncrypted: string): Promise<void>`
  - `enableAdminMfa(): Promise<void>`
  - `resetAdminMfa(): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/queries/mfa-state.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { users, patients } from '@/db/schema'
import { hashPassword } from '@/lib/password'
import {
  getUserMfaState, getUserNameById, setUserMfaSecret, enableUserMfa, resetUserMfa,
} from '@/lib/queries/users'
import {
  getPatientMfaState, setPatientMfaSecret, enablePatientMfa, resetPatientMfa,
} from '@/lib/queries/patient-portal'
import {
  getAdminMfaState, setAdminMfaSecret, enableAdminMfa, resetAdminMfa,
} from '@/lib/queries/settings'

const TEST_USER_EMAIL = 'test-mfa-state-user@example.com'
const TEST_PATIENT_ID = 'RD-MFA-TEST-01'
let testUserId: number

beforeAll(async () => {
  const [row] = await getDb().insert(users).values({ name: 'MFA Test User', email: TEST_USER_EMAIL, role: 'crc', passwordHash: hashPassword('irrelevant') }).returning()
  testUserId = row.id
  await getDb().insert(patients).values({
    id: TEST_PATIENT_ID, intakeqClientIdRef: 'ENC[test]', nameIntakeq: 'MFA Test Patient', dobIntakeq: '1990-01-01',
  })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, testUserId))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
  await resetAdminMfa() // leave the singleton appSettings row clean for other tests
})

describe('user MFA state', () => {
  it('starts unenrolled', async () => {
    expect(await getUserMfaState(testUserId)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
  it('provisions a secret without enabling', async () => {
    await setUserMfaSecret(testUserId, 'encrypted-secret')
    expect(await getUserMfaState(testUserId)).toEqual({ mfaSecretEncrypted: 'encrypted-secret', mfaEnabled: false })
  })
  it('enables after confirmation', async () => {
    await enableUserMfa(testUserId)
    expect(await getUserMfaState(testUserId)).toEqual({ mfaSecretEncrypted: 'encrypted-secret', mfaEnabled: true })
  })
  it('resets to unenrolled', async () => {
    await resetUserMfa(testUserId)
    expect(await getUserMfaState(testUserId)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
  it('looks up a name by id', async () => {
    expect(await getUserNameById(testUserId)).toBe('MFA Test User')
    expect(await getUserNameById(-1)).toBeNull()
  })
})

describe('patient MFA state', () => {
  it('starts unenrolled, then provisions, enables, and resets', async () => {
    expect(await getPatientMfaState(TEST_PATIENT_ID)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
    await setPatientMfaSecret(TEST_PATIENT_ID, 'encrypted-secret')
    expect((await getPatientMfaState(TEST_PATIENT_ID))?.mfaEnabled).toBe(false)
    await enablePatientMfa(TEST_PATIENT_ID)
    expect((await getPatientMfaState(TEST_PATIENT_ID))?.mfaEnabled).toBe(true)
    await resetPatientMfa(TEST_PATIENT_ID)
    expect(await getPatientMfaState(TEST_PATIENT_ID)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
})

describe('admin MFA state (appSettings singleton)', () => {
  it('starts unenrolled, then provisions, enables, and resets', async () => {
    await resetAdminMfa()
    expect(await getAdminMfaState()).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
    await setAdminMfaSecret('encrypted-admin-secret')
    expect((await getAdminMfaState()).mfaEnabled).toBe(false)
    await enableAdminMfa()
    expect((await getAdminMfaState()).mfaEnabled).toBe(true)
    await resetAdminMfa()
    expect(await getAdminMfaState()).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/lib/queries/mfa-state.test.ts`
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Implement — extend `src/lib/queries/users.ts`**

Add after `findUserByEmail`, and change `listAllUsers` to also select `mfaEnabled`:

```ts
/** Settings > Staff panel roster -- never returns passwordHash. */
export async function listAllUsers() {
  return getDb().select({ id: users.id, name: users.name, email: users.email, role: users.role, mfaEnabled: users.mfaEnabled }).from(users)
}

export async function getUserMfaState(userId: number): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean } | null> {
  const [row] = await getDb().select({ mfaSecretEncrypted: users.mfaSecretEncrypted, mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, userId))
  return row ?? null
}

export async function getUserNameById(userId: number): Promise<string | null> {
  const [row] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, userId))
  return row?.name ?? null
}

export async function setUserMfaSecret(userId: number, secretEncrypted: string): Promise<void> {
  await getDb().update(users).set({ mfaSecretEncrypted: secretEncrypted }).where(eq(users.id, userId))
}

export async function enableUserMfa(userId: number): Promise<void> {
  await getDb().update(users).set({ mfaEnabled: true }).where(eq(users.id, userId))
}

export async function resetUserMfa(userId: number): Promise<void> {
  await getDb().update(users).set({ mfaSecretEncrypted: null, mfaEnabled: false }).where(eq(users.id, userId))
}
```

(Replace the existing `listAllUsers` definition in place — don't leave two copies.)

- [ ] **Step 4: Implement — extend `src/lib/queries/patient-portal.ts`**

Add after `revokePatientPortalAccess`:

```ts
export async function getPatientMfaState(patientId: string): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean } | null> {
  const [row] = await getDb().select({ mfaSecretEncrypted: patients.mfaSecretEncrypted, mfaEnabled: patients.mfaEnabled }).from(patients).where(eq(patients.id, patientId))
  return row ?? null
}

export async function setPatientMfaSecret(patientId: string, secretEncrypted: string): Promise<void> {
  await getDb().update(patients).set({ mfaSecretEncrypted: secretEncrypted }).where(eq(patients.id, patientId))
}

export async function enablePatientMfa(patientId: string): Promise<void> {
  await getDb().update(patients).set({ mfaEnabled: true }).where(eq(patients.id, patientId))
}

export async function resetPatientMfa(patientId: string): Promise<void> {
  await getDb().update(patients).set({ mfaSecretEncrypted: null, mfaEnabled: false }).where(eq(patients.id, patientId))
}
```

- [ ] **Step 5: Implement — extend `src/lib/queries/settings.ts`**

Update the `getAppSettings` fallback object to include the two new fields, and add the admin-MFA functions:

```ts
export async function getAppSettings() {
  const [row] = await getDb().select().from(appSettings)
  return row ?? { id: 1, autoClassifyOnComplete: false, practiceName: null, practiceSite: null, practiceTimezone: 'America/Los_Angeles', intakeqApiKeyEncrypted: null, tebraCustomerKeyEncrypted: null, tebraUserEncrypted: null, tebraPasswordEncrypted: null, adminMfaSecretEncrypted: null, adminMfaEnabled: false }
}
```

Add at the end of the file:

```ts
export async function getAdminMfaState(): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean }> {
  const settings = await getAppSettings()
  return { mfaSecretEncrypted: settings.adminMfaSecretEncrypted, mfaEnabled: settings.adminMfaEnabled }
}

export async function setAdminMfaSecret(secretEncrypted: string): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ adminMfaSecretEncrypted: secretEncrypted }).where(eq(appSettings.id, current.id))
}

export async function enableAdminMfa(): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ adminMfaEnabled: true }).where(eq(appSettings.id, current.id))
}

export async function resetAdminMfa(): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ adminMfaSecretEncrypted: null, adminMfaEnabled: false }).where(eq(appSettings.id, current.id))
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/lib/queries/mfa-state.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add src/lib/queries/users.ts src/lib/queries/patient-portal.ts src/lib/queries/settings.ts tests/lib/queries/mfa-state.test.ts
git commit -m "feat: add MFA state read/write helpers for users, patients, and admin"
```

---

### Task 5: Staff two-step login (routes)

**Files:**
- Modify: `src/lib/rate-limit.ts` (add MFA-verify limiters)
- Modify: `src/app/api/login/route.ts`
- Create: `src/app/api/login/mfa/route.ts`
- Test: `tests/api/login-mfa.test.ts`

**Interfaces:**
- Consumes: `generateMfaEnrollment`/`verifyMfaCode` (Task 2), `setPendingStaffMfaCookie`/`getPendingStaffMfaSession`/`clearPendingStaffMfaCookie` (Task 3), `getAdminMfaState`/`setAdminMfaSecret`/`enableAdminMfa`/`getUserMfaState`/`setUserMfaSecret`/`enableUserMfa` (Task 4), `encryptSensitive`/`decryptSensitive` (existing `lib/crypto.ts`), `setSessionCookie` (existing `lib/auth.ts`), `logAudit` (existing).
- Produces: `POST /api/login` now returns `{mfaRequired: true, mode: 'enroll', qrDataUrl, manualKey}` or `{mfaRequired: true, mode: 'verify'}` on a correct password (patients are unaffected — this route is staff-only); `POST /api/login/mfa` returns `{ok: true}` on a correct code (and sets the real session cookie) or a 401/429 error. `checkStaffMfaRateLimit(ip: string, identity: string): Promise<{allowed: boolean}>`.

- [ ] **Step 1: Add the rate-limit bucket**

Add to `src/lib/rate-limit.ts`, after `checkLoginRateLimit`:

```ts
// Separate bucket from the password-check limiter above -- a correct
// password shouldn't share a counter with brute-forcing the 6-digit TOTP
// code that comes after it.
let _staffMfaLimiter: Ratelimit | null = null
function getStaffMfaLimiter() {
  if (!_staffMfaLimiter) {
    _staffMfaLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '60 s'),
      prefix: 'ratelimit:mfa-verify-staff',
    })
  }
  return _staffMfaLimiter
}

export async function checkStaffMfaRateLimit(ip: string, identity: string): Promise<{ allowed: boolean }> {
  const { success } = await getStaffMfaLimiter().limit(`${ip}:${identity}`)
  return { allowed: success }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/api/login-mfa.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { hashPassword } from '@/lib/password'
import { encryptSensitive } from '@/lib/crypto'
import { POST as login } from '@/app/api/login/route'
import { POST as loginMfa } from '@/app/api/login/mfa/route'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { setUserMfaSecret, enableUserMfa, getUserMfaState } from '@/lib/queries/users'

const TEST_HASH = hashPassword('s3cret-pass')
const TEST_DB_USER_EMAIL = 'test-login-mfa-user@example.com'
const TEST_DB_USER_PASSWORD = 'pi-test-pass-123'
let testUserId: number

vi.mock('@/lib/rate-limit', () => ({
  checkLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkStaffMfaRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

beforeAll(async () => {
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com')
  vi.stubEnv('ADMIN_PASSWORD_HASH', TEST_HASH)
  vi.stubEnv('ADMIN_NAME', 'Test Admin')
  const [row] = await getDb().insert(users).values({ name: 'Test PI', email: TEST_DB_USER_EMAIL, role: 'pi', passwordHash: hashPassword(TEST_DB_USER_PASSWORD) }).returning()
  testUserId = row.id
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await getDb().delete(users).where(eq(users.id, testUserId))
})

function req(body: unknown) {
  return new NextRequest('http://localhost/api/login', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
function mfaReq(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers['cookie'] = cookie
  return new NextRequest('http://localhost/api/login/mfa', { method: 'POST', body: JSON.stringify(body), headers })
}

describe('two-step staff login', () => {
  it('unenrolled user gets an enroll challenge, then a correct code logs them in', async () => {
    const enrollRes = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    expect(enrollRes.status).toBe(200)
    const enrollBody = await enrollRes.json()
    expect(enrollBody).toMatchObject({ mfaRequired: true, mode: 'enroll' })
    expect(enrollBody.qrDataUrl).toMatch(/^data:image\/png/)

    const state = await getUserMfaState(testUserId)
    expect(state?.mfaEnabled).toBe(false)
    expect(state?.mfaSecretEncrypted).toBeTruthy()

    const pendingCookie = enrollRes.cookies.get('clinsync_pending_staff_mfa')?.value
    const totp = new OTPAuth.TOTP({ issuer: 'Clinsync', label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret: enrollBody.manualKey })
    const verifyRes = await loginMfa(mfaReq({ code: totp.generate() }, `clinsync_pending_staff_mfa=${pendingCookie}`))
    expect(verifyRes.status).toBe(200)
    expect(await verifyRes.json()).toEqual({ ok: true })
    expect(verifyRes.cookies.get('clinsync_demo_session')).toBeTruthy()
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(true)
  })

  it('already-enrolled user gets a verify challenge, and a wrong code is rejected', async () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    await setUserMfaSecret(testUserId, encryptSensitive(secret.base32))
    await enableUserMfa(testUserId)

    const res = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    const body = await res.json()
    expect(body).toEqual({ mfaRequired: true, mode: 'verify' })
    const pendingCookie = res.cookies.get('clinsync_pending_staff_mfa')?.value

    const wrongRes = await loginMfa(mfaReq({ code: '000000' }, `clinsync_pending_staff_mfa=${pendingCookie}`))
    expect(wrongRes.status).toBe(401)
  })

  it('returns 401 with no pending cookie', async () => {
    const res = await loginMfa(mfaReq({ code: '123456' }))
    expect(res.status).toBe(401)
  })

  it('returns 429 when the rate limiter disallows the attempt, without checking the code', async () => {
    const { checkStaffMfaRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkStaffMfaRateLimit).mockResolvedValueOnce({ allowed: false })

    const enrollRes = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    const pendingCookie = enrollRes.cookies.get('clinsync_pending_staff_mfa')?.value
    const res = await loginMfa(mfaReq({ code: '000000' }, `clinsync_pending_staff_mfa=${pendingCookie}`))
    expect(res.status).toBe(429)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/api/login-mfa.test.ts`
Expected: FAIL — `POST as loginMfa` module doesn't exist yet, and `login`'s response shape doesn't match.

- [ ] **Step 4: Modify `src/app/api/login/route.ts`**

Add imports at the top:

```ts
import type { Role } from '@/lib/auth'
import { encryptSensitive } from '@/lib/crypto'
import { generateMfaEnrollment } from '@/lib/mfa'
import { setPendingStaffMfaCookie } from '@/lib/mfa-pending-session'
import { getAdminMfaState, setAdminMfaSecret } from '@/lib/queries/settings'
import { getUserMfaState, setUserMfaSecret } from '@/lib/queries/users'
```

Replace the two success branches (everything from `if (adminEmail && adminPasswordHash...` through the end of the function) with:

```ts
  if (adminEmail && adminPasswordHash && email.toLowerCase() === adminEmail.toLowerCase() && verifyPassword(password, adminPasswordHash)) {
    return startStaffMfaChallenge({ role: 'admin', name: adminName, userId: null })
  }

  const user = await findUserByEmail(email)
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    return startStaffMfaChallenge({ role: user.role, name: user.name, userId: user.id })
  }

  return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
}

// MFA is mandatory for every staff account, so a correct password never
// completes a login by itself anymore -- it always hands back an MFA
// challenge (enroll, the first time; verify, every time after).
async function startStaffMfaChallenge({ role, name, userId }: { role: Role; name: string; userId: number | null }) {
  const mfaState = userId === null ? await getAdminMfaState() : await getUserMfaState(userId)
  if (!mfaState || !mfaState.mfaEnabled) {
    const enrollment = await generateMfaEnrollment(`${name} <${role}>`)
    if (userId === null) await setAdminMfaSecret(encryptSensitive(enrollment.secretBase32))
    else await setUserMfaSecret(userId, encryptSensitive(enrollment.secretBase32))
    await setPendingStaffMfaCookie({ role, name, mode: 'enroll', userId })
    return NextResponse.json({ mfaRequired: true, mode: 'enroll', qrDataUrl: enrollment.qrDataUrl, manualKey: enrollment.secretBase32 })
  }
  await setPendingStaffMfaCookie({ role, name, mode: 'verify', userId })
  return NextResponse.json({ mfaRequired: true, mode: 'verify' })
}
```

- [ ] **Step 5: Create `src/app/api/login/mfa/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { setSessionCookie } from '@/lib/auth'
import { decryptSensitive } from '@/lib/crypto'
import { verifyMfaCode } from '@/lib/mfa'
import { getPendingStaffMfaSession, clearPendingStaffMfaCookie } from '@/lib/mfa-pending-session'
import { getAdminMfaState, enableAdminMfa } from '@/lib/queries/settings'
import { getUserMfaState, enableUserMfa } from '@/lib/queries/users'
import { checkStaffMfaRateLimit } from '@/lib/rate-limit'
import { logAudit } from '@/lib/audit'

const mfaSchema = z.object({ code: z.string().trim().length(6) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(request: NextRequest) {
  const pending = await getPendingStaffMfaSession()
  if (!pending) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = mfaSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid code' }, { status: 400 })

  const identity = pending.userId === null ? 'admin' : `user:${pending.userId}`
  const { allowed } = await checkStaffMfaRateLimit(getClientIp(request), identity)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const mfaState = pending.userId === null ? await getAdminMfaState() : await getUserMfaState(pending.userId)
  if (!mfaState?.mfaSecretEncrypted) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

  const secretBase32 = decryptSensitive(mfaState.mfaSecretEncrypted)
  if (!verifyMfaCode(secretBase32, parsed.data.code)) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
  }

  if (pending.mode === 'enroll') {
    if (pending.userId === null) await enableAdminMfa()
    else await enableUserMfa(pending.userId)
  }

  await clearPendingStaffMfaCookie()
  await setSessionCookie(pending.role, pending.name)
  await logAudit({ role: pending.role, name: pending.name }, pending.mode === 'enroll' ? 'enrolled in MFA and completed login' : 'completed MFA login', null)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/api/login-mfa.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the pre-existing login test to check for regressions**

Run: `npx dotenv -e .env.local -- vitest run tests/api/login.test.ts`
Expected: This file's existing assertions expect `{ok: true}` directly from a correct password — since staff MFA is now mandatory, this test file needs updating to expect the `{mfaRequired: true, ...}` challenge instead for any staff-role scenario it exercises. Read the file, update any assertion of the old direct-success shape to match the new challenge response, and re-run until it passes. Do not change what it tests for rate-limiting or wrong-password behavior — only the shape of a *correct*-password response.

- [ ] **Step 8: Commit**

```bash
git add src/lib/rate-limit.ts src/app/api/login/route.ts src/app/api/login/mfa/route.ts tests/api/login-mfa.test.ts tests/api/login.test.ts
git commit -m "feat: require TOTP MFA to complete staff login"
```

---

### Task 6: Patient two-step login (routes)

**Files:**
- Modify: `src/lib/rate-limit.ts` (add patient MFA-verify limiter)
- Modify: `src/app/api/patient-portal/login/route.ts`
- Create: `src/app/api/patient-portal/login/mfa/route.ts`
- Test: `tests/api/patient-portal-login-mfa.test.ts`

**Interfaces:**
- Consumes: `verifyMfaCode` (Task 2), `setPendingPatientMfaCookie`/`getPendingPatientMfaSession`/`clearPendingPatientMfaCookie` (Task 3), `getPatientMfaState` (Task 4), `decryptSensitive` (existing), `setPatientSessionCookie` (existing `lib/patient-session.ts`), `logPatientPortalAction` (existing).
- Produces: `POST /api/patient-portal/login` returns `{mfaRequired: true}` when the patient has opted in, otherwise unchanged `{ok: true}`. `POST /api/patient-portal/login/mfa` returns `{ok: true}` on a correct code or a 401/429 error. `checkPatientMfaRateLimit(ip: string, patientId: string): Promise<{allowed: boolean}>`.

- [ ] **Step 1: Add the rate-limit bucket**

Add to `src/lib/rate-limit.ts`, after `checkStaffMfaRateLimit`:

```ts
let _patientMfaLimiter: Ratelimit | null = null
function getPatientMfaLimiter() {
  if (!_patientMfaLimiter) {
    _patientMfaLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '60 s'),
      prefix: 'ratelimit:mfa-verify-patient',
    })
  }
  return _patientMfaLimiter
}

export async function checkPatientMfaRateLimit(ip: string, patientId: string): Promise<{ allowed: boolean }> {
  const { success } = await getPatientMfaLimiter().limit(`${ip}:${patientId}`)
  return { allowed: success }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/api/patient-portal-login-mfa.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { encryptSensitive } from '@/lib/crypto'
import { POST as login } from '@/app/api/patient-portal/login/route'
import { POST as loginMfa } from '@/app/api/patient-portal/login/mfa/route'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { setPatientPortalPassword } from '@/lib/queries/patient-portal'
import { setPatientMfaSecret, enablePatientMfa } from '@/lib/queries/patient-portal'

const TEST_PATIENT_ID = 'RD-LOGIN-MFA-01'
const TEST_PASSWORD = 'patient-test-pass-123'

vi.mock('@/lib/rate-limit', () => ({
  checkPatientLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkPatientMfaRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, intakeqClientIdRef: 'ENC[test]', nameIntakeq: 'Login MFA Test Patient', dobIntakeq: '1990-01-01' })
  await setPatientPortalPassword(TEST_PATIENT_ID, TEST_PASSWORD)
})

afterAll(async () => {
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

function req(body: unknown) {
  return new NextRequest('http://localhost/api/patient-portal/login', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
function mfaReq(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers['cookie'] = cookie
  return new NextRequest('http://localhost/api/patient-portal/login/mfa', { method: 'POST', body: JSON.stringify(body), headers })
}

describe('patient login without MFA enabled', () => {
  it('logs in exactly as before -- no mfaRequired in the response', async () => {
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.cookies.get('clinsync_patient_session')).toBeTruthy()
  })
})

describe('patient login with MFA enabled', () => {
  const secret = new OTPAuth.Secret({ size: 20 })

  beforeAll(async () => {
    await setPatientMfaSecret(TEST_PATIENT_ID, encryptSensitive(secret.base32))
    await enablePatientMfa(TEST_PATIENT_ID)
  })

  it('requires a second step, then a correct code logs in', async () => {
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    expect(await res.json()).toEqual({ mfaRequired: true })
    expect(res.cookies.get('clinsync_patient_session')).toBeFalsy()

    const pendingCookie = res.cookies.get('clinsync_pending_patient_mfa')?.value
    const totp = new OTPAuth.TOTP({ issuer: 'Clinsync', label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret })
    const verifyRes = await loginMfa(mfaReq({ code: totp.generate() }, `clinsync_pending_patient_mfa=${pendingCookie}`))
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.cookies.get('clinsync_patient_session')).toBeTruthy()
  })

  it('rejects a wrong code', async () => {
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    const pendingCookie = res.cookies.get('clinsync_pending_patient_mfa')?.value
    const wrongRes = await loginMfa(mfaReq({ code: '000000' }, `clinsync_pending_patient_mfa=${pendingCookie}`))
    expect(wrongRes.status).toBe(401)
  })

  it('returns 401 with no pending cookie', async () => {
    const res = await loginMfa(mfaReq({ code: '123456' }))
    expect(res.status).toBe(401)
  })

  it('returns 429 when the rate limiter disallows the attempt, without checking the code', async () => {
    const { checkPatientMfaRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkPatientMfaRateLimit).mockResolvedValueOnce({ allowed: false })

    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    const pendingCookie = res.cookies.get('clinsync_pending_patient_mfa')?.value
    const blockedRes = await loginMfa(mfaReq({ code: '000000' }, `clinsync_pending_patient_mfa=${pendingCookie}`))
    expect(blockedRes.status).toBe(429)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/api/patient-portal-login-mfa.test.ts`
Expected: FAIL — the new route module and response shape don't exist yet.

- [ ] **Step 4: Modify `src/app/api/patient-portal/login/route.ts`**

Add imports:

```ts
import { setPendingPatientMfaCookie } from '@/lib/mfa-pending-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
```

Replace the final block (from `await setPatientSessionCookie(patientId)` to the end) with:

```ts
  const mfaState = await getPatientMfaState(patientId)
  if (mfaState?.mfaEnabled) {
    await setPendingPatientMfaCookie({ patientId })
    return NextResponse.json({ mfaRequired: true })
  }

  await setPatientSessionCookie(patientId)
  await logPatientPortalAction('logged in to patient portal', patientId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Create `src/app/api/patient-portal/login/mfa/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { setPatientSessionCookie } from '@/lib/patient-session'
import { decryptSensitive } from '@/lib/crypto'
import { verifyMfaCode } from '@/lib/mfa'
import { getPendingPatientMfaSession, clearPendingPatientMfaCookie } from '@/lib/mfa-pending-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
import { checkPatientMfaRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const mfaSchema = z.object({ code: z.string().trim().length(6) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(request: NextRequest) {
  const pending = await getPendingPatientMfaSession()
  if (!pending) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = mfaSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid code' }, { status: 400 })

  const { allowed } = await checkPatientMfaRateLimit(getClientIp(request), pending.patientId)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const mfaState = await getPatientMfaState(pending.patientId)
  if (!mfaState?.mfaSecretEncrypted) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

  const secretBase32 = decryptSensitive(mfaState.mfaSecretEncrypted)
  if (!verifyMfaCode(secretBase32, parsed.data.code)) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
  }

  await clearPendingPatientMfaCookie()
  await setPatientSessionCookie(pending.patientId)
  await logPatientPortalAction('completed MFA login', pending.patientId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/api/patient-portal-login-mfa.test.ts`
Expected: PASS (5 tests) — including the Review Focus regression check (non-MFA patient login unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/lib/rate-limit.ts src/app/api/patient-portal/login/route.ts src/app/api/patient-portal/login/mfa/route.ts tests/api/patient-portal-login-mfa.test.ts
git commit -m "feat: support optional TOTP MFA in patient portal login"
```

---

### Task 7: Staff self-service MFA reset

**Files:**
- Create: `src/app/api/account/mfa/reset/route.ts`
- Test: `tests/api/account-mfa-reset.test.ts`

**Interfaces:**
- Consumes: `requireSession` (existing `lib/auth.ts`), `verifyPassword` (existing `lib/password.ts`), `findUserByEmail` (existing), `resetUserMfa` (Task 4), `resetAdminMfa` (Task 4), `logAudit` (existing).
- Produces: `POST /api/account/mfa/reset` — body `{email, password}`, requires an existing session, returns `{ok: true}` or a 401 error.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/account-mfa-reset.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { hashPassword } from '@/lib/password'
import { buildSessionCookieValue, SESSION_COOKIE_NAME } from '@/lib/auth'
import { POST as resetMfa } from '@/app/api/account/mfa/reset/route'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { setUserMfaSecret, enableUserMfa, getUserMfaState } from '@/lib/queries/users'
import { setAdminMfaSecret, enableAdminMfa, getAdminMfaState } from '@/lib/queries/settings'

const TEST_PASSWORD = 'pi-reset-test-pass-123'
const TEST_EMAIL = 'test-account-mfa-reset@example.com'
let testUserId: number

beforeAll(async () => {
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com')
  vi.stubEnv('ADMIN_PASSWORD_HASH', hashPassword('admin-test-pass'))
  vi.stubEnv('ADMIN_NAME', 'Test Admin')
  const [row] = await getDb().insert(users).values({ name: 'Reset Test PI', email: TEST_EMAIL, role: 'pi', passwordHash: hashPassword(TEST_PASSWORD) }).returning()
  testUserId = row.id
  await setUserMfaSecret(testUserId, 'enc-secret')
  await enableUserMfa(testUserId)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await getDb().delete(users).where(eq(users.id, testUserId))
})

async function reqAs(role: 'admin' | 'pi' | 'crc', name: string, body: unknown) {
  const cookie = await buildSessionCookieValue(role, name)
  return new NextRequest('http://localhost/api/account/mfa/reset', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  })
}

describe('self-service MFA reset', () => {
  it('resets the signed-in DB user\'s own MFA with correct credentials', async () => {
    const res = await resetMfa(await reqAs('pi', 'Reset Test PI', { email: TEST_EMAIL, password: TEST_PASSWORD }))
    expect(res.status).toBe(200)
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(false)
  })

  it('resets the admin\'s own MFA with correct env credentials', async () => {
    await setAdminMfaSecret('enc-admin-secret')
    await enableAdminMfa()
    const res = await resetMfa(await reqAs('admin', 'Test Admin', { email: 'admin@example.com', password: 'admin-test-pass' }))
    expect(res.status).toBe(200)
    expect((await getAdminMfaState()).mfaEnabled).toBe(false)
  })

  it('rejects a wrong password', async () => {
    const res = await resetMfa(await reqAs('pi', 'Reset Test PI', { email: TEST_EMAIL, password: 'wrong' }))
    expect(res.status).toBe(401)
  })

  it('rejects valid credentials for a DIFFERENT account than the caller\'s own session', async () => {
    // A signed-in `pi` session submitting the real admin credentials should
    // not be able to reset the admin's MFA -- see the Review Focus item.
    const res = await resetMfa(await reqAs('pi', 'Reset Test PI', { email: 'admin@example.com', password: 'admin-test-pass' }))
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/api/account-mfa-reset.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/app/api/account/mfa/reset/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { verifyPassword } from '@/lib/password'
import { findUserByEmail, resetUserMfa } from '@/lib/queries/users'
import { resetAdminMfa } from '@/lib/queries/settings'
import { logAudit } from '@/lib/audit'

const resetSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) }).strict()

// Lost-device recovery for a staff member who's still holding a trusted,
// signed-in session but can no longer produce a TOTP code -- re-verifies a
// password (the same credential a fresh login would check), then checks the
// re-authenticated identity against the CALLER's own session before
// clearing anything, so this can only ever reset your own MFA, never
// someone else's.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = resetSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  const { email, password } = parsed.data

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH
  if (adminEmail && adminPasswordHash && email.toLowerCase() === adminEmail.toLowerCase() && verifyPassword(password, adminPasswordHash)) {
    if (session.role !== 'admin') return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    await resetAdminMfa()
    await logAudit(session, 'reset own MFA', null)
    return NextResponse.json({ ok: true })
  }

  const user = await findUserByEmail(email)
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    if (session.role !== user.role || session.name !== user.name) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    await resetUserMfa(user.id)
    await logAudit(session, 'reset own MFA', null)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/api/account-mfa-reset.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/account/mfa/reset/route.ts tests/api/account-mfa-reset.test.ts
git commit -m "feat: let staff reset their own MFA via password re-authentication"
```

---

### Task 8: Patient opt-in MFA (enroll, confirm, reset)

**Files:**
- Create: `src/app/api/patient-portal/account/mfa/enroll/route.ts`
- Create: `src/app/api/patient-portal/account/mfa/confirm/route.ts`
- Create: `src/app/api/patient-portal/account/mfa/reset/route.ts`
- Test: `tests/api/patient-portal-account-mfa.test.ts`

**Interfaces:**
- Consumes: `requirePatientSession` (existing `lib/patient-session.ts`), `generateMfaEnrollment`/`verifyMfaCode` (Task 2), `getPatientMfaState`/`setPatientMfaSecret`/`enablePatientMfa`/`resetPatientMfa` (Task 4), `verifyPatientPortalCredentials` (existing), `checkPatientMfaRateLimit`/`checkPatientLoginRateLimit` (Tasks 6/existing), `logPatientPortalAction` (existing).
- Produces: `POST /api/patient-portal/account/mfa/enroll` → `{qrDataUrl, manualKey}`; `POST /api/patient-portal/account/mfa/confirm` (body `{code}`) → `{ok: true}`; `POST /api/patient-portal/account/mfa/reset` (body `{password}`) → `{ok: true}`. All three require a full patient session (not a pending one).

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/patient-portal-account-mfa.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { setPatientSessionCookie, PATIENT_SESSION_COOKIE_NAME } from '@/lib/patient-session'
import { POST as enroll } from '@/app/api/patient-portal/account/mfa/enroll/route'
import { POST as confirm } from '@/app/api/patient-portal/account/mfa/confirm/route'
import { POST as reset } from '@/app/api/patient-portal/account/mfa/reset/route'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { setPatientPortalPassword, getPatientMfaState } from '@/lib/queries/patient-portal'

const TEST_PATIENT_ID = 'RD-ACCT-MFA-01'
const TEST_PASSWORD = 'acct-mfa-test-pass-123'

vi.mock('@/lib/rate-limit', () => ({
  checkPatientMfaRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkPatientLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, intakeqClientIdRef: 'ENC[test]', nameIntakeq: 'Account MFA Test Patient', dobIntakeq: '1990-01-01' })
  await setPatientPortalPassword(TEST_PATIENT_ID, TEST_PASSWORD)
})

afterAll(async () => {
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

async function reqAs(path: string, body: unknown) {
  // jose needs a real signed cookie, not a hand-rolled one -- reuse the real
  // session-cookie minter the same way the patient login flow does.
  const { setPatientSessionCookie: _unused } = await import('@/lib/patient-session')
  void _unused
  return { path, body }
}

describe('patient opt-in MFA', () => {
  let manualKey: string

  it('enroll returns a QR and manual key, and provisions an unconfirmed secret', async () => {
    // Mint a real patient session cookie via next/headers' mocked store,
    // same approach as the existing patient-session tests.
    const cookieJar: Record<string, string> = {}
    vi.doMock('next/headers', () => ({
      cookies: async () => ({
        get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined),
        set: (name: string, value: string) => { cookieJar[name] = value },
        delete: (name: string) => { delete cookieJar[name] },
      }),
    }))
    await setPatientSessionCookie(TEST_PATIENT_ID)

    const res = await enroll(new NextRequest('http://localhost/api/patient-portal/account/mfa/enroll', { method: 'POST', headers: { cookie: `${PATIENT_SESSION_COOKIE_NAME}=${cookieJar[PATIENT_SESSION_COOKIE_NAME]}` } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.qrDataUrl).toMatch(/^data:image\/png/)
    manualKey = body.manualKey

    const state = await getPatientMfaState(TEST_PATIENT_ID)
    expect(state?.mfaEnabled).toBe(false)
    expect(state?.mfaSecretEncrypted).toBeTruthy()
  })

  it('confirm with the correct code enables MFA', async () => {
    const totp = new OTPAuth.TOTP({ issuer: 'Clinsync', label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret: manualKey })
    const cookieHeader = `${PATIENT_SESSION_COOKIE_NAME}=irrelevant` // see note below
    const res = await confirm(new NextRequest('http://localhost/api/patient-portal/account/mfa/confirm', { method: 'POST', body: JSON.stringify({ code: totp.generate() }), headers: { 'Content-Type': 'application/json', cookie: cookieHeader } }))
    // This assertion depends on the mocked next/headers store from the
    // previous test still holding the session -- if your test runner
    // isolates module mocks per-test, re-mint the session cookie here the
    // same way the enroll test did before calling confirm().
    expect(res.status).toBe(200)
    expect((await getPatientMfaState(TEST_PATIENT_ID))?.mfaEnabled).toBe(true)
  })

  it('reset with the correct password disables MFA', async () => {
    const res = await reset(new NextRequest('http://localhost/api/patient-portal/account/mfa/reset', { method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }), headers: { 'Content-Type': 'application/json' } }))
    expect(res.status).toBe(200)
    expect(await getPatientMfaState(TEST_PATIENT_ID)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
})
```

**Note for the implementer:** the mocked-cookie-jar approach above is fiddly across separate `it()` blocks because each route handler calls `cookies()` fresh. If mock isolation causes flakiness, restructure this file to mint the patient session cookie header string directly with `setPatientSessionCookie`'s underlying `SignJWT` call (same pattern `tests/api/login-mfa.test.ts` uses for `buildSessionCookieValue`) and pass it as a literal `cookie:` header on every request, rather than relying on a shared mocked store across tests. Prioritize correctness of the three routes' actual logic over preserving this exact test structure.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/api/patient-portal-account-mfa.test.ts`
Expected: FAIL — none of the three route modules exist yet.

- [ ] **Step 3: Create `src/app/api/patient-portal/account/mfa/enroll/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { requirePatientSession } from '@/lib/patient-session'
import { encryptSensitive } from '@/lib/crypto'
import { generateMfaEnrollment } from '@/lib/mfa'
import { getPatientMfaState, setPatientMfaSecret } from '@/lib/queries/patient-portal'

export async function POST() {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const mfaState = await getPatientMfaState(session.patientId)
  if (mfaState?.mfaEnabled) return NextResponse.json({ error: 'MFA is already enabled' }, { status: 400 })

  const enrollment = await generateMfaEnrollment(session.patientId)
  await setPatientMfaSecret(session.patientId, encryptSensitive(enrollment.secretBase32))

  return NextResponse.json({ qrDataUrl: enrollment.qrDataUrl, manualKey: enrollment.secretBase32 })
}
```

- [ ] **Step 4: Create `src/app/api/patient-portal/account/mfa/confirm/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { decryptSensitive } from '@/lib/crypto'
import { verifyMfaCode } from '@/lib/mfa'
import { getPatientMfaState, enablePatientMfa } from '@/lib/queries/patient-portal'
import { checkPatientMfaRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const confirmSchema = z.object({ code: z.string().trim().length(6) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid code' }, { status: 400 })

  const { allowed } = await checkPatientMfaRateLimit(getClientIp(request), session.patientId)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const mfaState = await getPatientMfaState(session.patientId)
  if (!mfaState?.mfaSecretEncrypted || mfaState.mfaEnabled) return NextResponse.json({ error: 'No enrollment in progress' }, { status: 400 })

  const secretBase32 = decryptSensitive(mfaState.mfaSecretEncrypted)
  if (!verifyMfaCode(secretBase32, parsed.data.code)) return NextResponse.json({ error: 'Invalid code' }, { status: 401 })

  await enablePatientMfa(session.patientId)
  await logPatientPortalAction('enabled MFA', session.patientId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Create `src/app/api/patient-portal/account/mfa/reset/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { verifyPatientPortalCredentials } from '@/lib/queries/patient-portal'
import { resetPatientMfa } from '@/lib/queries/patient-portal'
import { checkPatientLoginRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const resetSchema = z.object({ password: z.string().min(1) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

// Also doubles as "turn MFA back off" -- MFA is opt-in for patients, so
// disabling it is a self-service action, not an admin-only one the way a
// staff reset is.
export async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = resetSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })

  const { allowed } = await checkPatientLoginRateLimit(getClientIp(request), session.patientId)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const valid = await verifyPatientPortalCredentials(session.patientId, parsed.data.password)
  if (!valid) return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })

  await resetPatientMfa(session.patientId)
  await logPatientPortalAction('reset own MFA', session.patientId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/api/patient-portal-account-mfa.test.ts`
Expected: PASS (3 tests) — fix up the cookie-mocking approach per the note in Step 1 if it's flaky.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/patient-portal/account/mfa src/lib/queries/patient-portal.ts tests/api/patient-portal-account-mfa.test.ts
git commit -m "feat: let patients opt into, confirm, and reset their own MFA"
```

---

### Task 9: Admin-triggered MFA reset (staff and patient)

**Files:**
- Create: `src/app/api/users/[id]/reset-mfa/route.ts`
- Create: `src/app/api/patients/[anonId]/reset-mfa/route.ts`
- Test: `tests/api/reset-mfa-admin.test.ts`

**Interfaces:**
- Consumes: `requireSession` (existing), `getUserNameById`/`resetUserMfa` (Task 4), `resetPatientMfa` (Task 4), `logAudit` (existing).
- Produces: `POST /api/users/[id]/reset-mfa` and `POST /api/patients/[anonId]/reset-mfa`, both admin-only, both `{ok: true}` or 403 for a non-admin caller.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/reset-mfa-admin.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { hashPassword } from '@/lib/password'
import { buildSessionCookieValue, SESSION_COOKIE_NAME } from '@/lib/auth'
import { POST as resetUserMfaRoute } from '@/app/api/users/[id]/reset-mfa/route'
import { POST as resetPatientMfaRoute } from '@/app/api/patients/[anonId]/reset-mfa/route'
import { getDb } from '@/db/client'
import { users, patients } from '@/db/schema'
import { setUserMfaSecret, enableUserMfa, getUserMfaState } from '@/lib/queries/users'
import { setPatientMfaSecret, enablePatientMfa, getPatientMfaState } from '@/lib/queries/patient-portal'

const TEST_EMAIL = 'test-admin-reset-target@example.com'
const TEST_PATIENT_ID = 'RD-ADMIN-RESET-01'
let testUserId: number

beforeAll(async () => {
  const [row] = await getDb().insert(users).values({ name: 'Admin Reset Target', email: TEST_EMAIL, role: 'crc', passwordHash: hashPassword('irrelevant') }).returning()
  testUserId = row.id
  await setUserMfaSecret(testUserId, 'enc')
  await enableUserMfa(testUserId)

  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, intakeqClientIdRef: 'ENC[test]', nameIntakeq: 'Admin Reset Target Patient', dobIntakeq: '1990-01-01' })
  await setPatientMfaSecret(TEST_PATIENT_ID, 'enc')
  await enablePatientMfa(TEST_PATIENT_ID)
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, testUserId))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

async function cookieFor(role: 'admin' | 'pi' | 'crc', name: string) {
  return `${SESSION_COOKIE_NAME}=${await buildSessionCookieValue(role, name)}`
}

describe('admin-triggered MFA reset', () => {
  it('rejects a non-admin caller for the staff reset route', async () => {
    const req = new NextRequest(`http://localhost/api/users/${testUserId}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('crc', 'Some CRC') } })
    const res = await resetUserMfaRoute(req, { params: Promise.resolve({ id: String(testUserId) }) })
    expect(res.status).toBe(403)
  })

  it('admin resets a staff member\'s MFA', async () => {
    const req = new NextRequest(`http://localhost/api/users/${testUserId}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('admin', 'Test Admin') } })
    const res = await resetUserMfaRoute(req, { params: Promise.resolve({ id: String(testUserId) }) })
    expect(res.status).toBe(200)
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(false)
  })

  it('rejects a non-admin caller for the patient reset route', async () => {
    const req = new NextRequest(`http://localhost/api/patients/${TEST_PATIENT_ID}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('pi', 'Some PI') } })
    const res = await resetPatientMfaRoute(req, { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(403)
  })

  it('admin resets a patient\'s MFA', async () => {
    const req = new NextRequest(`http://localhost/api/patients/${TEST_PATIENT_ID}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('admin', 'Test Admin') } })
    const res = await resetPatientMfaRoute(req, { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(200)
    expect(await getPatientMfaState(TEST_PATIENT_ID)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run tests/api/reset-mfa-admin.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Create `src/app/api/users/[id]/reset-mfa/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { getUserNameById, resetUserMfa } from '@/lib/queries/users'
import { logAudit } from '@/lib/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const userId = Number(id)
  if (!Number.isInteger(userId)) return NextResponse.json({ error: 'Invalid staff account id' }, { status: 400 })

  const name = await getUserNameById(userId)
  if (!name) return NextResponse.json({ error: 'Staff account not found' }, { status: 404 })

  await resetUserMfa(userId)
  await logAudit(session, `reset MFA for staff member ${name}`, null)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Create `src/app/api/patients/[anonId]/reset-mfa/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { resetPatientMfa } from '@/lib/queries/patient-portal'
import { logAudit } from '@/lib/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { anonId } = await params
  await resetPatientMfa(anonId)
  await logAudit(session, 'reset MFA for patient', anonId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run tests/api/reset-mfa-admin.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/users/\[id\]/reset-mfa src/app/api/patients/\[anonId\]/reset-mfa tests/api/reset-mfa-admin.test.ts
git commit -m "feat: let an admin reset another staff member's or a patient's MFA"
```

---

### Task 10: Staff login page UI (two-step)

**Files:**
- Create: `src/components/mfa/MfaCodeStep.tsx`
- Create: `src/components/mfa/MfaEnrollStep.tsx`
- Modify: `src/app/login/page.tsx`

**Interfaces:**
- Consumes: `POST /api/login` and `POST /api/login/mfa` (Task 5).
- Produces: reusable `<MfaCodeStep>` and `<MfaEnrollStep>` components, also consumed by Task 11's patient-portal Security page.

This is a UI-only task with no automated test — matches this codebase's existing convention of not unit-testing page-level client components (see `tests/` — it covers `lib/` and `api/`, not `app/**/page.tsx`). Verify manually per Step 4 below.

- [ ] **Step 1: Create `src/components/mfa/MfaCodeStep.tsx`**

```tsx
'use client'
import { useState } from 'react'

// Shared by staff login (verify mode), patient login (verify mode), and the
// patient portal's Security page (confirming a fresh enrollment) -- one
// "enter your 6-digit code" form instead of three near-duplicates.
export function MfaCodeStep({ title, description, onSubmit, onBack }: {
  title: string
  description: string
  onSubmit: (code: string) => Promise<string | null> // resolves to an error message, or null on success
  onBack?: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const err = await onSubmit(code)
    setSubmitting(false)
    if (err) {
      setError(err)
      setCode('')
    }
  }

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="text-xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="mfa-code" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">6-digit code</label>
          <input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-center text-lg tracking-[0.5em] text-foreground focus:border-primary focus:outline-none"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className="w-full text-center text-xs font-medium text-muted-foreground hover:text-foreground">
            Back
          </button>
        )}
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/mfa/MfaEnrollStep.tsx`**

```tsx
'use client'
import { useState } from 'react'
import Image from 'next/image'

export function MfaEnrollStep({ qrDataUrl, manualKey, onSubmit }: {
  qrDataUrl: string
  manualKey: string
  onSubmit: (code: string) => Promise<string | null>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const err = await onSubmit(code)
    setSubmitting(false)
    if (err) {
      setError(err)
      setCode('')
    }
  }

  return (
    <div>
      <div className="mb-4 text-center">
        <h1 className="text-xl font-bold text-foreground">Set up two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted-foreground">Scan this code with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
      </div>
      <div className="mb-4 flex justify-center">
        <Image src={qrDataUrl} alt="Scan with your authenticator app" width={180} height={180} className="rounded-lg border border-border" unoptimized />
      </div>
      <p className="mb-4 text-center text-xs text-muted-foreground">
        Can&apos;t scan it? Enter this key manually: <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground">{manualKey}</code>
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-center text-lg tracking-[0.5em] text-foreground focus:border-primary focus:outline-none"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Confirming…' : 'Confirm and finish setup'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: Rewrite `src/app/login/page.tsx`**

Keep the left-panel branding JSX (lines 39-69 of the current file) exactly as-is. Replace the component's state and the right-panel card content:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck, Users, FlaskConical } from 'lucide-react'
import { IpmgIcon } from '@/components/IpmgLogo'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'
import { MfaEnrollStep } from '@/components/mfa/MfaEnrollStep'

const HIGHLIGHTS = [
  { icon: FlaskConical, text: 'Automated inclusion/exclusion screening against live trial criteria' },
  { icon: Users, text: 'A single reconciled patient record across every source system' },
  { icon: ShieldCheck, text: 'Identity verification and audit logging built in' },
]

type Step =
  | { kind: 'password' }
  | { kind: 'enroll'; qrDataUrl: string; manualKey: string }
  | { kind: 'verify' }

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState<Step>({ kind: 'password' })

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    setSubmitting(false)
    if (!res.ok) {
      setError('Invalid email or password.')
      return
    }
    const body = await res.json()
    setStep(body.mode === 'enroll' ? { kind: 'enroll', qrDataUrl: body.qrDataUrl, manualKey: body.manualKey } : { kind: 'verify' })
  }

  async function submitMfaCode(code: string): Promise<string | null> {
    const res = await fetch('/api/login/mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return body?.error ?? 'Could not verify that code.'
    }
    router.push('/')
    router.refresh()
    return null
  }

  return (
    <div className="flex min-h-screen bg-background">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)', backgroundSize: '28px 28px' }}
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-3">
          <div className="rounded-lg bg-white/95 px-3 py-2">
            <IpmgIcon className="h-6 w-auto" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Clinsync</span>
        </div>
        <div className="relative space-y-8">
          <h2 className="max-w-sm text-3xl font-bold leading-tight">Pre-screening, reconciled across every system, in one place.</h2>
          <ul className="space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="text-sm text-sidebar-foreground/80">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-foreground/50">Clinical-trial pre-screening workbook</p>
      </div>

      <div className="flex w-full flex-1 flex-col items-center justify-center px-4 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col gap-1 lg:hidden">
            <div className="mb-3 flex items-center gap-2.5 text-foreground">
              <IpmgIcon className="h-6 w-auto" />
              <span className="text-lg font-semibold tracking-tight">Clinsync</span>
            </div>
          </div>
          <div className="rounded-2xl border border-primary/10 bg-card p-7 shadow-md">
            {step.kind === 'password' && (
              <>
                <div className="mb-6">
                  <h1 className="text-2xl font-bold text-foreground">Welcome back</h1>
                  <p className="mt-1 text-sm text-muted-foreground">Sign in to continue to your workspace.</p>
                </div>
                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="email" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</label>
                    <input
                      id="email"
                      type="email"
                      required
                      autoComplete="username"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Password</label>
                    <input
                      id="password"
                      type="password"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {submitting ? 'Signing in…' : 'Sign in'}
                  </button>
                </form>
              </>
            )}
            {step.kind === 'enroll' && (
              <MfaEnrollStep qrDataUrl={step.qrDataUrl} manualKey={step.manualKey} onSubmit={submitMfaCode} />
            )}
            {step.kind === 'verify' && (
              <MfaCodeStep
                title="Enter your code"
                description="Open your authenticator app and enter the current 6-digit code."
                onSubmit={submitMfaCode}
                onBack={() => setStep({ kind: 'password' })}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, then in a browser:
1. Go to `/login` with a staff account that has never enrolled MFA. Confirm the password step transitions to the QR-enrollment screen, and that the manual key works if you compute a code from it (e.g. via any TOTP CLI/app).
2. Confirm a correct code lands on `/` and a wrong code shows "Invalid code" without losing the enrollment screen.
3. Log out and log back in with the same account — confirm it now shows the "Enter your code" verify screen, not enrollment again.

- [ ] **Step 5: Commit**

```bash
git add src/components/mfa src/app/login/page.tsx
git commit -m "feat: two-step MFA UI for staff login"
```

---

### Task 11: Patient login page UI + patient portal Security page

**Files:**
- Modify: `src/app/patient-portal/login/page.tsx`
- Create: `src/app/patient-portal/(authenticated)/security/page.tsx`
- Create: `src/components/PatientPortalSecurityPanel.tsx`
- Modify: `src/components/PatientPortalSideNav.tsx`

**Interfaces:**
- Consumes: `POST /api/patient-portal/login`, `POST /api/patient-portal/login/mfa` (Task 6); `POST /api/patient-portal/account/mfa/{enroll,confirm,reset}` (Task 8); `<MfaCodeStep>`, `<MfaEnrollStep>` (Task 10); `getPatientMfaState` (Task 4, for the Security page's initial server-rendered status).

UI-only task, verified manually (see Task 10's note on this codebase's test conventions).

- [ ] **Step 1: Modify `src/app/patient-portal/login/page.tsx`**

Add a `step` state the same shape as the staff login page (minus the `enroll` variant — patients never enroll mid-login, only via the Security page). Replace the `submit` function and the form-rendering block:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Pill, MessageSquare, LockKeyhole } from 'lucide-react'
import { IpmgIcon } from '@/components/IpmgLogo'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'

const HIGHLIGHTS = [
  { icon: FileText, text: 'Forms' },
  { icon: Pill, text: 'Medications' },
  { icon: MessageSquare, text: 'Messages' },
]

export default function PatientPortalLoginPage() {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [needsMfa, setNeedsMfa] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/patient-portal/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, password }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not sign in.')
      return
    }
    const body = await res.json()
    if (body.mfaRequired) {
      setNeedsMfa(true)
      return
    }
    router.push('/patient-portal')
  }

  async function submitMfaCode(code: string): Promise<string | null> {
    const res = await fetch('/api/patient-portal/login/mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return body?.error ?? 'Could not verify that code.'
    }
    router.push('/patient-portal')
    return null
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-secondary/40 px-4 py-10">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-primary/10 to-transparent"
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl bg-white px-4 py-3 shadow-sm">
            <IpmgIcon className="h-8 w-auto" />
          </div>
          <div>
            <p className="text-lg font-semibold tracking-tight text-foreground">Clinsync Patient Portal</p>
            <p className="text-sm text-muted-foreground">Inland Psychiatric Medical Group</p>
          </div>
        </div>

        <div className="rounded-2xl border border-primary/10 bg-card p-7 shadow-md">
          {needsMfa ? (
            <MfaCodeStep
              title="Enter your code"
              description="Open your authenticator app and enter the current 6-digit code."
              onSubmit={submitMfaCode}
              onBack={() => setNeedsMfa(false)}
            />
          ) : (
            <>
              <div className="mb-6 text-center">
                <h1 className="text-xl font-bold text-foreground">Welcome back</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sign in with the patient ID and password your care team gave you.
                </p>
              </div>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label htmlFor="patientId" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient ID</label>
                  <input
                    id="patientId"
                    value={patientId}
                    onChange={(e) => setPatientId(e.target.value)}
                    placeholder="RD-0001"
                    className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Password</label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none"
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <button
                  type="submit"
                  disabled={submitting || !patientId || !password}
                  className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {submitting ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
              <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                Your health information is private and secure
              </p>
            </>
          )}
        </div>

        {!needsMfa && (
          <>
            <div className="mt-6 flex items-center justify-center gap-6">
              {HIGHLIGHTS.map(({ icon: Icon, text }) => (
                <div key={text} className="flex flex-col items-center gap-1.5 text-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="text-[11px] font-medium text-muted-foreground">{text}</span>
                </div>
              ))}
            </div>
            <p className="mt-6 text-center text-xs text-muted-foreground">
              Don&apos;t have a patient ID or password yet? Ask your provider&apos;s office.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/PatientPortalSecurityPanel.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { MfaEnrollStep } from '@/components/mfa/MfaEnrollStep'

export function PatientPortalSecurityPanel({ initialMfaEnabled }: { initialMfaEnabled: boolean }) {
  const [mfaEnabled, setMfaEnabled] = useState(initialMfaEnabled)
  const [enrollment, setEnrollment] = useState<{ qrDataUrl: string; manualKey: string } | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [showReset, setShowReset] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function startEnroll() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/patient-portal/account/mfa/enroll', { method: 'POST' })
    setBusy(false)
    if (!res.ok) { setError('Could not start enrollment.'); return }
    setEnrollment(await res.json())
  }

  async function confirmEnroll(code: string): Promise<string | null> {
    const res = await fetch('/api/patient-portal/account/mfa/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return body?.error ?? 'Could not confirm that code.'
    }
    setEnrollment(null)
    setMfaEnabled(true)
    return null
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/patient-portal/account/mfa/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: resetPassword }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not turn off two-factor authentication.')
      return
    }
    setMfaEnabled(false)
    setShowReset(false)
    setResetPassword('')
  }

  if (enrollment) {
    return <MfaEnrollStep qrDataUrl={enrollment.qrDataUrl} manualKey={enrollment.manualKey} onSubmit={confirmEnroll} />
  }

  return (
    <div className="rounded-2xl border border-primary/10 bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-foreground">Security</h1>
      <p className="mb-4 text-sm text-muted-foreground">Add a second step to your sign-in for extra protection.</p>

      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${mfaEnabled ? 'bg-success' : 'bg-muted-foreground'}`} aria-hidden="true" />
        <span className="text-foreground">{mfaEnabled ? 'Two-factor authentication is on' : 'Two-factor authentication is off'}</span>
      </div>

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {!mfaEnabled && !showReset && (
        <button onClick={startEnroll} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          Enable two-factor authentication
        </button>
      )}

      {mfaEnabled && !showReset && (
        <button onClick={() => setShowReset(true)} className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10">
          Turn off two-factor authentication
        </button>
      )}

      {showReset && (
        <form onSubmit={submitReset} className="space-y-3">
          <div>
            <label htmlFor="reset-password" className="mb-1 block text-xs font-medium text-muted-foreground">Confirm your password</label>
            <input
              id="reset-password"
              type="password"
              required
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              Turn off
            </button>
            <button type="button" onClick={() => setShowReset(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create `src/app/patient-portal/(authenticated)/security/page.tsx`**

```tsx
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
import { PatientPortalSecurityPanel } from '@/components/PatientPortalSecurityPanel'

export default async function PatientPortalSecurityPage() {
  const session = await requirePatientSessionOrRedirect()
  const mfaState = await getPatientMfaState(session.patientId)

  return (
    <div className="max-w-lg">
      <PatientPortalSecurityPanel initialMfaEnabled={mfaState?.mfaEnabled ?? false} />
    </div>
  )
}
```

- [ ] **Step 4: Add the nav entry in `src/components/PatientPortalSideNav.tsx`**

Add `ShieldCheck` to the `lucide-react` import, and add a new entry to `ITEMS` (after `Messages`, before the array closes):

```ts
import { LayoutDashboard, FileText, Pill, CalendarCheck, MessageSquare, Megaphone, ShieldCheck } from 'lucide-react'
```

```ts
const ITEMS: { href: string; label: string; icon: Icon }[] = [
  { href: '/patient-portal', label: 'Overview', icon: LayoutDashboard },
  { href: '/patient-portal/forms', label: 'Forms', icon: FileText },
  { href: '/patient-portal/broadcasts', label: 'Announcements', icon: Megaphone },
  { href: '/patient-portal/medications', label: 'Medications', icon: Pill },
  { href: '/patient-portal/appointments', label: 'Appointments', icon: CalendarCheck },
  { href: '/patient-portal/messages', label: 'Messages', icon: MessageSquare },
  { href: '/patient-portal/security', label: 'Security', icon: ShieldCheck },
]
```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, log into the patient portal as a patient with no MFA enabled, go to "Security", click "Enable two-factor authentication", scan/compute a code, confirm it flips to "on". Log out, log back in, confirm the portal login now asks for a code. Go back to Security, turn it off with the correct password, confirm login no longer asks for a code.

- [ ] **Step 6: Commit**

```bash
git add src/app/patient-portal/login/page.tsx "src/app/patient-portal/(authenticated)/security" src/components/PatientPortalSecurityPanel.tsx src/components/PatientPortalSideNav.tsx
git commit -m "feat: patient-facing MFA opt-in UI and portal login step"
```

---

### Task 12: Admin-facing MFA status and reset controls

**Files:**
- Modify: `src/app/(dashboard)/settings/page.tsx` (Account tab)
- Create: `src/components/settings/StaffMfaSelfResetForm.tsx`
- Modify: `src/components/settings/StaffManagementPanel.tsx`
- Modify: `src/components/PatientPortalAccessPanel.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx`

**Interfaces:**
- Consumes: `POST /api/account/mfa/reset` (Task 7), `POST /api/users/[id]/reset-mfa` (Task 9), `POST /api/patients/[anonId]/reset-mfa` (Task 9), `listAllUsers()` now including `mfaEnabled` (Task 4).

UI-only task, verified manually.

- [ ] **Step 1: Create `src/components/settings/StaffMfaSelfResetForm.tsx`**

```tsx
'use client'
import { useState } from 'react'

// Lost-device recovery while still holding a trusted, signed-in session --
// re-enters the same email+password a fresh login would check. Works for
// admin too (see api/account/mfa/reset), so there's no separate "admin
// recovers admin" mechanism needed.
export function StaffMfaSelfResetForm({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/account/mfa/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not reset MFA.')
      return
    }
    setDone(true)
    setOpen(false)
  }

  if (done) {
    return <p className="text-xs text-muted-foreground">MFA has been reset. You&apos;ll set it up again next time you sign in.</p>
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary">
        Reset my MFA
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
      <div>
        <label htmlFor="self-reset-password" className="mb-1 block text-xs font-medium text-muted-foreground">Confirm your password</label>
        <input
          id="self-reset-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          Reset MFA
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Wire it into the Settings Account tab**

In `src/app/(dashboard)/settings/page.tsx`, add the import:

```ts
import { StaffMfaSelfResetForm } from '@/components/settings/StaffMfaSelfResetForm'
```

`accountTab`'s JSX currently ends with the "What you can do" section. The Account tab renders `session`, which has `role`/`name` but no `email` — fetch it before building `accountTab`. Add, right after `const capabilities = ROLE_CAPABILITIES[session.role]`:

```ts
  const currentUserEmail = session.role === 'admin' ? (process.env.ADMIN_EMAIL ?? '') : (staff.find((s) => s.name === session.name && s.role === session.role)?.email ?? '')
```

Then add a new section inside `accountTab`'s outer `<div className="space-y-4">`, after the "What you can do" `<section>`:

```tsx
      <section className={SECTION}>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Security</h2>
        <p className="mb-3 text-sm text-muted-foreground">Two-factor authentication is required for every staff account. If you&apos;ve lost your device, reset it here and set it up again on your next sign-in.</p>
        <StaffMfaSelfResetForm email={currentUserEmail} />
      </section>
```

- [ ] **Step 3: Modify `src/components/settings/StaffManagementPanel.tsx`**

Add `mfaEnabled` to `StaffRow`:

```ts
export interface StaffRow {
  id: number
  name: string
  email: string
  role: 'admin' | 'pi' | 'crc'
  mfaEnabled: boolean
}
```

Add a small reset handler and button inside the `<li>` row-rendering block (the `{staff.map((s) => (...))}` in the exported `StaffManagementPanel` component) — add a `useRouter` import and a per-row action:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, Copy, Check } from 'lucide-react'
```

Inside `StaffManagementPanel`, add:

```tsx
export function StaffManagementPanel({ staff, isAdmin }: { staff: StaffRow[]; isAdmin: boolean }) {
  const router = useRouter()
  const [newCredential, setNewCredential] = useState<{ row: StaffRow; password: string } | null>(null)
  const [resetting, setResetting] = useState<number | null>(null)

  function handleCreated(row: StaffRow, password: string) {
    setNewCredential({ row, password })
    router.refresh()
  }

  async function resetMfa(id: number) {
    setResetting(id)
    await fetch(`/api/users/${id}/reset-mfa`, { method: 'POST' })
    setResetting(null)
    router.refresh()
  }
```

And in the row markup, replace the closing of each `<li>` (currently ending right after the role badge `<span>`) to add the button when admin and MFA is enabled:

```tsx
            <li key={s.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">{s.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_BADGE[s.role]}`}>{ROLE_LABEL[s.role]}</span>
                {isAdmin && s.mfaEnabled && (
                  <button onClick={() => resetMfa(s.id)} disabled={resetting === s.id} className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
                    {resetting === s.id ? 'Resetting…' : 'Reset MFA'}
                  </button>
                )}
              </div>
            </li>
```

- [ ] **Step 4: Modify `src/components/PatientPortalAccessPanel.tsx`**

Add an `mfaEnabled` prop and a reset button next to the existing "Revoke access" button:

```tsx
'use client'
import { useState } from 'react'

export function PatientPortalAccessPanel({ anonId, initialConfigured, mfaEnabled, isAdmin }: { anonId: string; initialConfigured: boolean; mfaEnabled: boolean; isAdmin: boolean }) {
  const [configured, setConfigured] = useState(initialConfigured)
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mfaResetting, setMfaResetting] = useState(false)
  const [mfaWasReset, setMfaWasReset] = useState(false)
```

Add a handler alongside `generate`/`revoke`:

```ts
  async function resetMfa() {
    setMfaResetting(true)
    setError(null)
    const res = await fetch(`/api/patients/${anonId}/reset-mfa`, { method: 'POST' })
    setMfaResetting(false)
    if (!res.ok) { setError('Could not reset MFA.'); return }
    setMfaWasReset(true)
  }
```

Add the button next to the existing "Revoke access" one, inside the `<div className="flex gap-2">`:

```tsx
      <div className="flex gap-2">
        <button onClick={generate} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {configured ? 'Reset portal password' : 'Enable portal access'}
        </button>
        {configured && (
          <button onClick={revoke} disabled={busy} className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
            Revoke access
          </button>
        )}
        {mfaEnabled && !mfaWasReset && (
          <button onClick={resetMfa} disabled={mfaResetting} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
            {mfaResetting ? 'Resetting…' : 'Reset MFA'}
          </button>
        )}
      </div>
      {mfaWasReset && <p className="text-xs text-muted-foreground">MFA has been reset for this patient.</p>}
```

- [ ] **Step 5: Wire the new props into their pages**

In `src/app/(dashboard)/settings/page.tsx`, pass `staff` to `StaffManagementPanel` unchanged — it already includes `mfaEnabled` from Task 4's `listAllUsers()` change, and `StaffRow` above now expects it, so no further edit is needed there beyond what Step 3 already covers.

In `src/app/(dashboard)/patients/[anonId]/page.tsx`, update the `PatientPortalAccessPanel` usage:

```tsx
        <PatientPortalAccessPanel anonId={patient.id} initialConfigured={patient.portalConfigured} mfaEnabled={patient.mfaEnabled} isAdmin={session.role === 'admin'} />
```

(`patient.mfaEnabled` is already present on the object returned by `getPatientDetail`/equivalent in `src/lib/queries/patients.ts`, since that function does `select()` — the full row — and spreads it with `...patient`; no query change needed there.)

- [ ] **Step 6: Manual verification**

Run: `npm run dev`. As admin: go to Settings > Staff, confirm a "Reset MFA" button appears only for staff with MFA enabled, click it, confirm that staff member is forced through enrollment on next login. Go to a patient's detail page with MFA enabled, click "Reset MFA" in the portal access panel, confirm the patient can no longer log in with their old code. As a signed-in `pi` or `crc`, go to Settings > Account, use "Reset my MFA", confirm your own next login re-enrolls.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(dashboard\)/settings/page.tsx src/components/settings/StaffMfaSelfResetForm.tsx src/components/settings/StaffManagementPanel.tsx src/components/PatientPortalAccessPanel.tsx "src/app/(dashboard)/patients/[anonId]/page.tsx"
git commit -m "feat: admin and self-service MFA status/reset controls"
```

---

### Task 13: Patient-portal idle auto-logoff

**Files:**
- Create: `src/components/PatientPortalSessionTimeoutWarning.tsx`
- Modify: `src/app/patient-portal/(authenticated)/layout.tsx`

**Interfaces:**
- Consumes: existing `POST /api/patient-portal/logout` route.
- Produces: nothing consumed elsewhere — this is a leaf UI component, independent of every other task in this plan.

UI-only task, verified manually.

- [ ] **Step 1: Create `src/components/PatientPortalSessionTimeoutWarning.tsx`**

Direct port of `src/components/SessionTimeoutWarning.tsx`, same 10/12-minute numbers, targeting the patient logout route and the patient login page:

```tsx
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const WARN_AFTER_MS = 10 * 60 * 1000
const LOGOUT_AFTER_MS = 12 * 60 * 1000

export function PatientPortalSessionTimeoutWarning() {
  const [showWarning, setShowWarning] = useState(false)
  const router = useRouter()
  const warnTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const logoutTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const reset = useCallback(() => {
    clearTimeout(warnTimer.current)
    clearTimeout(logoutTimer.current)
    setShowWarning(false)
    warnTimer.current = setTimeout(() => setShowWarning(true), WARN_AFTER_MS)
    logoutTimer.current = setTimeout(() => {
      fetch('/api/patient-portal/logout', { method: 'POST' }).finally(() => router.push('/patient-portal/login'))
    }, LOGOUT_AFTER_MS)
  }, [router])

  useEffect(() => {
    reset()
    window.addEventListener('mousemove', reset)
    window.addEventListener('keydown', reset)
    return () => {
      clearTimeout(warnTimer.current)
      clearTimeout(logoutTimer.current)
      window.removeEventListener('mousemove', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [reset])

  if (!showWarning) return null

  return (
    <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="rounded-lg bg-card p-6 shadow-lg">
        <p className="mb-2 font-semibold text-foreground">You&apos;ll be signed out soon</p>
        <p className="mb-4 text-sm text-muted-foreground">For your privacy, inactive sessions end automatically.</p>
        <button onClick={reset} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90">
          Stay signed in
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the patient-portal authenticated layout**

Modify `src/app/patient-portal/(authenticated)/layout.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalIdentity } from '@/lib/queries/patient-portal'
import { PatientPortalSideNav } from '@/components/PatientPortalSideNav'
import { PatientPortalTopBar } from '@/components/PatientPortalTopBar'
import { PatientPortalSessionTimeoutWarning } from '@/components/PatientPortalSessionTimeoutWarning'

export default async function PatientPortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePatientSessionOrRedirect()
  const identity = await getPatientPortalIdentity(session.patientId)
  if (!identity) notFound()

  return (
    <div className="flex h-screen overflow-hidden">
      <PatientPortalSessionTimeoutWarning />
      <PatientPortalSideNav />
      <div className="flex flex-1 flex-col overflow-hidden">
        <PatientPortalTopBar name={identity.name} dob={identity.dob} patientId={identity.id} />
        <main className="flex-1 overflow-y-auto bg-background p-6">{children}</main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, log into the patient portal, wait (or temporarily lower `WARN_AFTER_MS`/`LOGOUT_AFTER_MS` locally to seconds for testing, then revert) to confirm the warning dialog appears and "Stay signed in" resets the timer, and that 12 minutes of total inactivity redirects to `/patient-portal/login` with the session actually cleared (confirm a manual reload doesn't silently re-enter the portal).

- [ ] **Step 4: Commit**

```bash
git add src/components/PatientPortalSessionTimeoutWarning.tsx "src/app/patient-portal/(authenticated)/layout.tsx"
git commit -m "feat: idle auto-logoff for patient portal sessions"
```

---

## Final branch review

After all 13 tasks are complete, run the full suite once (`npx dotenv -e .env.local -- vitest run`) and confirm nothing outside this plan's own new/modified test files regressed, then do a whole-branch review per the chosen execution skill (subagent-driven-development's final review pass) before merging.
