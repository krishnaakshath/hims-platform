# Authentication Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give staff login three more ways to satisfy the second factor beyond TOTP — SMS OTP, email OTP (via real SMTP), and Google OAuth SSO — each account picking one method, with SSO as a fully separate sign-in path.

**Architecture:** Extend the existing two-step login flow (`POST /api/login` → challenge → `POST /api/login/mfa` → session) to branch on a new `mfaMethod` column instead of always assuming TOTP; add one new OTP delivery module shared by SMS and email; add a fully separate PKCE-protected OAuth flow for Google sign-in that matches (never creates) a `users` row.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM/Neon Postgres, Upstash Redis (`@upstash/ratelimit`), `jose` (signed cookies), `nodemailer` (new dependency, SMTP email), plain `fetch` for Twilio's REST API and Google's OAuth/JWKS endpoints (no new SDK needed for either).

**Spec:** `docs/superpowers/specs/2026-09-26-authentication-hardening.md`

## Global Constraints

- Schema changes are additive only, applied via a one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push` (the database is shared across every branch/environment).
- No commit may include a attribution trailer.
- Every new rate limiter follows `src/lib/rate-limit.ts`'s exact dual-bucket pattern: a per-IP `Ratelimit.slidingWindow` bucket AND an IP-independent global-by-identity bucket, both must pass.
- OTP codes (SMS/email) are never stored in Postgres — only their SHA-256 hash in Redis, with a TTL, deleted on first successful verification (single-use).
- SMS/email/SSO must fail loudly (a clear error, login blocked) when their required env vars are absent — never silently let a login through unauthenticated.
- SSO never auto-creates a `users` row. A Google sign-in that matches no existing account (by `googleSub` then `email`) is rejected with a clear message.
- Known environment issue for this whole plan's execution: the Neon HTTP driver used by `npx vitest`/`npx tsx` has intermittent (sometimes sustained) connectivity failures in this sandbox (confirmed via `psql "$DATABASE_URL"` that the database itself is always healthy — this is specific to Node's fetch path on port 443). Retry a failing DB-touching vitest command 2-3 times; if still failing, verify the underlying SQL/logic directly via `psql -f <script>` inside `BEGIN...ROLLBACK` and document exactly what was verified that way in the task report.
- Vitest command: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false` is already configured project-wide).

## Review Focus

1. **A staff account switches to `sms`/`email` with no `phone` on file / no SMTP configured** — must be blocked at the switch step or fail loudly at send time, never silently accept a login with no code ever delivered. (Task 5, Task 2)
2. **Google sign-in with an email/sub matching no `users` row** — must reject cleanly, never auto-provision a new staff account. (Task 4)
3. **OAuth `state` mismatch or a replayed/expired PKCE cookie** — the callback must reject it, not silently proceed with an unverified flow. (Task 4)
4. **OTP code reuse** — a code already verified once must be rejected on a second submission (single-use, same replay-safety property TOTP already has). (Task 2)
5. **Rate limiting on OTP send/verify** — a burst of resend/verify requests must not make a 6-digit code brute-forceable within its 5-minute window. (Task 2)

---

### Task 1: Schema migration — `mfaMethod`, `phone`, `googleSub`

**Files:**
- Modify: `src/db/schema.ts`
- Create (throwaway, not committed): one-off migration script

**Interfaces:**
- Produces: `mfaMethodEnum` (`'totp' | 'sms' | 'email'`); `users.mfaMethod` (default `'totp'`), `users.phone` (nullable), `users.googleSub` (nullable); `appSettings.adminMfaMethod` (default `'totp'`), `appSettings.adminPhone` (nullable).

- [ ] **Step 1: Add the schema definitions**

In `src/db/schema.ts`, add near the top (after `roleEnum`):

```ts
export const mfaMethodEnum = pgEnum('mfa_method', ['totp', 'sms', 'email'])
```

In the `users` table definition, add three columns after `mfaEnabled`:

```ts
  mfaMethod: mfaMethodEnum('mfa_method').default('totp').notNull(),
  phone: text('phone'),
  googleSub: text('google_sub'),
```

In the `appSettings` table definition, add two columns after `adminMfaEnabled`:

```ts
  adminMfaMethod: mfaMethodEnum('admin_mfa_method').default('totp').notNull(),
  adminPhone: text('admin_phone'),
```

- [ ] **Step 2: Write and run the one-off migration script**

Create a scratch file at `/tmp/migrate-auth-hardening.ts` (do not commit):

```ts
import { getDb } from '../src/db/client'
import { sql } from 'drizzle-orm'

async function main() {
  const db = getDb()

  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE mfa_method AS ENUM ('totp', 'sms', 'email');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_method mfa_method NOT NULL DEFAULT 'totp'`)
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`)
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT`)
  await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_mfa_method mfa_method NOT NULL DEFAULT 'totp'`)
  await db.execute(sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_phone TEXT`)

  console.log('Authentication hardening migration complete.')
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx /tmp/migrate-auth-hardening.ts` (or, if this fails with a Neon HTTP connectivity error per the Global Constraints note, apply the identical SQL via `psql "$DATABASE_URL" -f <file-with-the-same-statements>`). Confirm success, then delete the scratch file.

- [ ] **Step 3: Verify against the schema types**

Run: `npx tsc --noEmit`
Expected: no errors referencing `mfaMethodEnum`, `mfaMethod`, `phone`, `googleSub`, `adminMfaMethod`, or `adminPhone`.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: add mfaMethod/phone/googleSub columns for authentication hardening"
```

---

### Task 2: OTP delivery core (SMS + email) with rate limiting

**Files:**
- Create: `src/lib/otp-delivery.ts`
- Create: `src/lib/sms.ts`
- Create: `src/lib/email.ts`
- Modify: `src/lib/rate-limit.ts`
- Modify: `package.json` (add `nodemailer` + `@types/nodemailer`)
- Test: `tests/lib/otp-delivery.test.ts`

**Interfaces:**
- Consumes: `getRedis()` from `@/lib/cache`.
- Produces: `generateAndSendOtp(identity: string, channel: 'sms' | 'email', destination: string): Promise<void>`; `verifyOtp(identity: string, channel: 'sms' | 'email', code: string): Promise<boolean>`; `sendSms(toPhone: string, code: string): Promise<void>`; `sendEmail(toEmail: string, subject: string, body: string): Promise<void>`; `checkOtpSendRateLimit(ip: string, identity: string): Promise<{allowed: boolean}>`; `checkOtpVerifyRateLimit(ip: string, identity: string): Promise<{allowed: boolean}>`. Task 3 consumes all of these.

- [ ] **Step 1: Install the new dependency**

```bash
npm install nodemailer
npm install --save-dev @types/nodemailer
```

- [ ] **Step 2: Write the failing determinism/single-use test**

Create `tests/lib/otp-delivery.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateAndSendOtp, verifyOtp } from '@/lib/otp-delivery'

vi.mock('@/lib/sms', () => ({ sendSms: vi.fn(async () => undefined) }))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => undefined) }))

afterEach(() => {
  vi.clearAllMocks()
})

describe('generateAndSendOtp / verifyOtp', () => {
  it('sends via sendSms for the sms channel', async () => {
    const { sendSms } = await import('@/lib/sms')
    await generateAndSendOtp('test-identity-1', 'sms', '+15551234567')
    expect(sendSms).toHaveBeenCalledTimes(1)
    const [toPhone] = vi.mocked(sendSms).mock.calls[0]
    expect(toPhone).toBe('+15551234567')
  })

  it('sends via sendEmail for the email channel', async () => {
    const { sendEmail } = await import('@/lib/email')
    await generateAndSendOtp('test-identity-2', 'email', 'staff@example.com')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const [toEmail] = vi.mocked(sendEmail).mock.calls[0]
    expect(toEmail).toBe('staff@example.com')
  })

  it('verifies the exact code that was sent, and rejects a wrong code', async () => {
    const { sendSms } = await import('@/lib/sms')
    await generateAndSendOtp('test-identity-3', 'sms', '+15551234567')
    const [, sentCode] = vi.mocked(sendSms).mock.calls[0]
    expect(await verifyOtp('test-identity-3', 'sms', '000000')).toBe(false)
    expect(await verifyOtp('test-identity-3', 'sms', sentCode)).toBe(true)
  })

  it('rejects a code that was already successfully verified once (single-use)', async () => {
    const { sendSms } = await import('@/lib/sms')
    await generateAndSendOtp('test-identity-4', 'sms', '+15551234567')
    const [, sentCode] = vi.mocked(sendSms).mock.calls[0]
    expect(await verifyOtp('test-identity-4', 'sms', sentCode)).toBe(true)
    expect(await verifyOtp('test-identity-4', 'sms', sentCode)).toBe(false)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/otp-delivery.test.ts`
Expected: FAIL — the modules don't exist yet.

- [ ] **Step 4: Implement `src/lib/sms.ts`**

```ts
export async function sendSms(toPhone: string, code: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_FROM_NUMBER
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('SMS sign-in is not configured (missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER).')
  }

  const body = new URLSearchParams({
    To: toPhone,
    From: fromNumber,
    Body: `Your Clinsync verification code is ${code}. It expires in 5 minutes.`,
  })

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
    body,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to send SMS via Twilio (${res.status}): ${detail}`)
  }
}
```

- [ ] **Step 5: Implement `src/lib/email.ts`**

```ts
import nodemailer from 'nodemailer'

export async function sendEmail(toEmail: string, subject: string, body: string): Promise<void> {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT
  const user = process.env.SMTP_USER
  const password = process.env.SMTP_PASSWORD
  const from = process.env.SMTP_FROM
  if (!host || !port || !user || !password || !from) {
    throw new Error('Email sign-in is not configured (missing SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM).')
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: { user, pass: password },
  })

  await transporter.sendMail({ from, to: toEmail, subject, text: body })
}
```

- [ ] **Step 6: Add the OTP rate limiters to `src/lib/rate-limit.ts`**

Append, following the exact dual-bucket pattern already used above in the same file:

```ts
// Separate buckets from every other limiter in this file -- an OTP send/verify
// flow is a fresh brute-force surface (a 6-digit code, same guessable space as
// TOTP) and must not share a counter with password or TOTP attempts.
let _otpSendLimiter: Ratelimit | null = null
function getOtpSendLimiter() {
  if (!_otpSendLimiter) {
    _otpSendLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '900 s'),
      prefix: 'ratelimit:otp-send',
    })
  }
  return _otpSendLimiter
}

let _otpSendGlobalLimiter: Ratelimit | null = null
function getOtpSendGlobalLimiter() {
  if (!_otpSendGlobalLimiter) {
    _otpSendGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '900 s'),
      prefix: 'ratelimit:otp-send-global',
    })
  }
  return _otpSendGlobalLimiter
}

export async function checkOtpSendRateLimit(ip: string, identity: string): Promise<{ allowed: boolean }> {
  const [perIp, global] = await Promise.all([
    getOtpSendLimiter().limit(`${ip}:${identity}`),
    getOtpSendGlobalLimiter().limit(identity),
  ])
  return { allowed: perIp.success && global.success }
}

let _otpVerifyLimiter: Ratelimit | null = null
function getOtpVerifyLimiter() {
  if (!_otpVerifyLimiter) {
    _otpVerifyLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '900 s'),
      prefix: 'ratelimit:otp-verify',
    })
  }
  return _otpVerifyLimiter
}

let _otpVerifyGlobalLimiter: Ratelimit | null = null
function getOtpVerifyGlobalLimiter() {
  if (!_otpVerifyGlobalLimiter) {
    _otpVerifyGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '900 s'),
      prefix: 'ratelimit:otp-verify-global',
    })
  }
  return _otpVerifyGlobalLimiter
}

export async function checkOtpVerifyRateLimit(ip: string, identity: string): Promise<{ allowed: boolean }> {
  const [perIp, global] = await Promise.all([
    getOtpVerifyLimiter().limit(`${ip}:${identity}`),
    getOtpVerifyGlobalLimiter().limit(identity),
  ])
  return { allowed: perIp.success && global.success }
}
```

- [ ] **Step 7: Implement `src/lib/otp-delivery.ts`**

```ts
import { createHash, randomInt, timingSafeEqual } from 'crypto'
import { getRedis } from '@/lib/cache'
import { sendSms } from '@/lib/sms'
import { sendEmail } from '@/lib/email'

const OTP_TTL_SECONDS = 300 // 5 minutes, matches the copy shown to the user

function otpKey(identity: string, channel: 'sms' | 'email'): string {
  return `otp:${channel}:${identity}`
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export async function generateAndSendOtp(identity: string, channel: 'sms' | 'email', destination: string): Promise<void> {
  const code = String(randomInt(100000, 1000000))
  await getRedis().set(otpKey(identity, channel), hashCode(code), { ex: OTP_TTL_SECONDS })

  if (channel === 'sms') {
    await sendSms(destination, code)
  } else {
    await sendEmail(destination, 'Your Clinsync verification code', `Your verification code is ${code}. It expires in 5 minutes.`)
  }
}

export async function verifyOtp(identity: string, channel: 'sms' | 'email', code: string): Promise<boolean> {
  const key = otpKey(identity, channel)
  const stored = await getRedis().get<string>(key)
  if (!stored) return false

  const candidate = Buffer.from(hashCode(code))
  const expected = Buffer.from(stored)
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected)
  if (!matches) return false

  // Single-use: delete on first successful match so a resubmitted or
  // intercepted code can never be replayed, same intent as TOTP's replay
  // guard in src/lib/mfa.ts, simpler here since there's exactly one valid
  // value at a time rather than a rolling time-window of them.
  await getRedis().del(key)
  return true
}
```

- [ ] **Step 8: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/otp-delivery.test.ts`
Expected: PASS (all 4 tests). This test doesn't touch Postgres (only Redis + mocked senders), so it should be unaffected by the Neon HTTP connectivity issue — if it still fails with a connection error, check whether `getRedis()` itself is reachable (`npx dotenv -e .env.local -- node -e "require('@upstash/redis')"`-style smoke check) before assuming it's the same Neon issue.

- [ ] **Step 9: Commit**

```bash
git add src/lib/otp-delivery.ts src/lib/sms.ts src/lib/email.ts src/lib/rate-limit.ts package.json package-lock.json tests/lib/otp-delivery.test.ts
git commit -m "feat: add SMS/email OTP delivery core with rate limiting"
```

---

### Task 3: Login flow integration (branch on mfaMethod)

**Files:**
- Modify: `src/lib/mfa-pending-session.ts`
- Modify: `src/app/api/login/route.ts`
- Modify: `src/app/api/login/mfa/route.ts`
- Modify: `src/app/login/page.tsx`
- Test: `tests/api/login.test.ts` (append)
- Test: `tests/api/login-mfa.test.ts` (append, or create if it doesn't exist — check first with `ls tests/api/login-mfa.test.ts`; if the file doesn't exist, the existing coverage for `/api/login/mfa` lives inside `tests/api/login.test.ts` — append there instead)

**Interfaces:**
- Consumes: `generateAndSendOtp`, `verifyOtp` from Task 2; `checkOtpSendRateLimit`, `checkOtpVerifyRateLimit` from Task 2.
- Produces: `PendingStaffMfaSession` gains a `method: 'totp' | 'sms' | 'email'` field — Task 4 does not need this (SSO bypasses the pending-MFA flow entirely), but note it here since it's a shared type.

- [ ] **Step 1: Extend `PendingStaffMfaSession`**

In `src/lib/mfa-pending-session.ts`, change:

```ts
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
```

to:

```ts
export interface PendingStaffMfaSession {
  role: Role
  name: string
  mode: 'enroll' | 'verify'
  userId: number | null // null = the env-based admin account
  method: 'totp' | 'sms' | 'email'
}

export async function setPendingStaffMfaCookie(session: PendingStaffMfaSession): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-staff-mfa', role: session.role, name: session.name, mode: session.mode, userId: session.userId, method: session.method })
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
      (payload.userId === null || typeof payload.userId === 'number') &&
      (payload.method === 'totp' || payload.method === 'sms' || payload.method === 'email')
    ) {
      return { role: payload.role as Role, name: payload.name, mode: payload.mode, userId: payload.userId as number | null, method: payload.method }
    }
    return null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Write the failing test for SMS/email login challenge**

Append to `tests/api/login.test.ts` (check the file's existing top-level mocks/imports first — reuse whatever pattern it already uses for hitting `POST /api/login` against a real seeded `crc`/`pi` account; the exact mock shape depends on what's already there, but the new tests below assume `POST` is imported from `@/app/api/login/route` and a real DB user can be created/cleaned up the same way the file's other tests do):

```ts
describe('POST /api/login with mfaMethod sms/email', () => {
  it('sends an SMS OTP and does not return a QR code when the account mfaMethod is sms', async () => {
    vi.doMock('@/lib/otp-delivery', () => ({ generateAndSendOtp: vi.fn(async () => undefined), verifyOtp: vi.fn(async () => false) }))
    vi.resetModules()
    const [{ POST: loginPost }, { getDb }, { users }] = await Promise.all([
      import('@/app/api/login/route'),
      import('@/db/client'),
      import('@/db/schema'),
    ])
    const { hashPassword } = await import('@/lib/password')
    const [created] = await getDb().insert(users).values({
      name: 'SMS Test User', email: 'sms-test-user@example.com', role: 'crc',
      passwordHash: hashPassword('SmsTestPass123!'), mfaMethod: 'sms', phone: '+15551234567',
    }).returning()

    const req = new Request('http://localhost/api/login', { method: 'POST', body: JSON.stringify({ email: 'sms-test-user@example.com', password: 'SmsTestPass123!' }) })
    const res = await loginPost(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mfaRequired).toBe(true)
    expect(body.mode).toBe('sms')
    expect(body.qrDataUrl).toBeUndefined()

    const { eq } = await import('drizzle-orm')
    await getDb().delete(users).where(eq(users.id, created.id))
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/login.test.ts`
Expected: FAIL — `startStaffMfaChallenge` doesn't branch on `mfaMethod` yet.

- [ ] **Step 4: Update `src/app/api/login/route.ts`**

Replace the whole file's `POST` handler and `startStaffMfaChallenge` function (everything from `export async function POST` to the end of the file) with:

```ts
export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid login payload' }, { status: 400 })
  }

  const { email, password } = parsed.data
  const ip = getClientIp(request)

  const { allowed } = await checkLoginRateLimit(ip, email)
  if (!allowed) {
    return NextResponse.json({ error: 'Too many login attempts. Try again in a minute.' }, { status: 429 })
  }

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH
  const adminName = process.env.ADMIN_NAME ?? 'Admin'

  // The one real admin account still authenticates via env vars, not a DB
  // row -- checked first so its behavior is byte-for-byte unchanged. Any
  // other provisioned account (pi/crc/frontdesk) authenticates against
  // users.passwordHash. Same generic error for a wrong email, a wrong
  // password, or an account with no password set at all, so this endpoint
  // never confirms which part was wrong or whether an email exists.
  if (adminEmail && adminPasswordHash && email.toLowerCase() === adminEmail.toLowerCase() && verifyPassword(password, adminPasswordHash)) {
    const adminMfaState = await getAdminMfaState()
    return startStaffMfaChallenge({ role: 'admin', name: adminName, userId: null, ip, mfaMethod: adminMfaState.mfaMethod, phone: adminMfaState.phone, email: adminEmail })
  }

  const user = await findUserByEmail(email)
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    return startStaffMfaChallenge({ role: user.role, name: user.name, userId: user.id, ip, mfaMethod: user.mfaMethod, phone: user.phone, email: user.email })
  }

  return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
}

// MFA is mandatory for every staff account, so a correct password never
// completes a login by itself anymore -- it always hands back a challenge:
// enroll or verify for totp (unchanged), or an OTP send for sms/email.
async function startStaffMfaChallenge({ role, name, userId, ip, mfaMethod, phone, email }: { role: Role; name: string; userId: number | null; ip: string; mfaMethod: 'totp' | 'sms' | 'email'; phone: string | null; email: string }) {
  const identity = userId === null ? 'admin' : `user:${userId}`

  if (mfaMethod === 'sms' || mfaMethod === 'email') {
    const { checkOtpSendRateLimit } = await import('@/lib/rate-limit')
    const { generateAndSendOtp } = await import('@/lib/otp-delivery')
    const { allowed } = await checkOtpSendRateLimit(ip, identity)
    if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })

    const destination = mfaMethod === 'sms' ? phone : email
    if (!destination) return NextResponse.json({ error: `No ${mfaMethod === 'sms' ? 'phone number' : 'email'} is on file for this account. Contact your admin.` }, { status: 400 })

    try {
      await generateAndSendOtp(identity, mfaMethod, destination)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : `Could not send a ${mfaMethod} code.` }, { status: 500 })
    }

    await setPendingStaffMfaCookie({ role, name, mode: 'verify', userId, method: mfaMethod })
    return NextResponse.json({ mfaRequired: true, mode: mfaMethod })
  }

  const mfaState = userId === null ? await getAdminMfaState() : await getUserMfaState(userId)
  if (!mfaState || !mfaState.mfaEnabled) {
    const enrollment = await generateMfaEnrollment(`${name} <${role}>`)
    if (userId === null) await setAdminMfaSecret(encryptSensitive(enrollment.secretBase32))
    else await setUserMfaSecret(userId, encryptSensitive(enrollment.secretBase32))
    await setPendingStaffMfaCookie({ role, name, mode: 'enroll', userId, method: 'totp' })
    return NextResponse.json({ mfaRequired: true, mode: 'enroll', qrDataUrl: enrollment.qrDataUrl, manualKey: enrollment.secretBase32 })
  }
  await setPendingStaffMfaCookie({ role, name, mode: 'verify', userId, method: 'totp' })
  return NextResponse.json({ mfaRequired: true, mode: 'verify' })
}
```

This requires `getAdminMfaState()` (in `src/lib/queries/settings.ts`) to also return `mfaMethod`/`phone`. Update it from:

```ts
export async function getAdminMfaState(): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean }> {
  const settings = await getAppSettings()
  return { mfaSecretEncrypted: settings.adminMfaSecretEncrypted, mfaEnabled: settings.adminMfaEnabled }
}
```

to:

```ts
export async function getAdminMfaState(): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean; mfaMethod: 'totp' | 'sms' | 'email'; phone: string | null }> {
  const settings = await getAppSettings()
  return { mfaSecretEncrypted: settings.adminMfaSecretEncrypted, mfaEnabled: settings.adminMfaEnabled, mfaMethod: settings.adminMfaMethod, phone: settings.adminPhone }
}
```

`getUserMfaState` (`src/lib/queries/users.ts`) does NOT need `mfaMethod`/`phone` added to its own return type for this task — `POST /api/login`'s DB-user branch reads `user.mfaMethod`/`user.phone` directly off the `user` row `findUserByEmail` already returned (a full-row select), not through `getUserMfaState` (which stays scoped to what `POST /api/login/mfa` needs from Task 3 Step 6, unchanged from today).

- [ ] **Step 5: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/login.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `POST /api/login/mfa`**

In `src/app/api/login/mfa/route.ts`, replace the TOTP-only verification with a branch on `pending.method`:

```ts
  if (pending.method === 'sms' || pending.method === 'email') {
    const { checkOtpVerifyRateLimit } = await import('@/lib/rate-limit')
    const { verifyOtp } = await import('@/lib/otp-delivery')
    const { allowed } = await checkOtpVerifyRateLimit(getClientIp(request), identity)
    if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

    if (!(await verifyOtp(identity, pending.method, parsed.data.code))) {
      await logAudit({ role: pending.role, name: pending.name }, `failed ${pending.method} OTP entry`, null)
      return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
    }
  } else {
    const mfaState = pending.userId === null ? await getAdminMfaState() : await getUserMfaState(pending.userId)
    if (!mfaState?.mfaSecretEncrypted) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

    const secretBase32 = decryptSensitive(mfaState.mfaSecretEncrypted)
    if (!(await verifyMfaCode(secretBase32, parsed.data.code, identity))) {
      await logAudit({ role: pending.role, name: pending.name }, 'failed MFA code entry', null)
      return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
    }

    if (pending.mode === 'enroll') {
      if (pending.userId === null) await enableAdminMfa()
      else await enableUserMfa(pending.userId)
    }
  }
```

(Keep this as a replacement for the existing verification block in the middle of the function — the rate-limit check at the top of the function, the `clearPendingStaffMfaCookie`/`setSessionCookie`/final `logAudit` calls at the bottom stay exactly as they are today.)

- [ ] **Step 7: Update `src/app/login/page.tsx`**

Change the `Step` union type to:

```ts
type Step =
  | { kind: 'password' }
  | { kind: 'enroll'; qrDataUrl: string; manualKey: string }
  | { kind: 'verify'; method: 'totp' | 'sms' | 'email' }
```

Update `handlePasswordSubmit`'s success branch:

```ts
    if (body.mode === 'enroll') {
      setStep({ kind: 'enroll', qrDataUrl: body.qrDataUrl, manualKey: body.manualKey })
    } else {
      setStep({ kind: 'verify', method: body.mode as 'totp' | 'sms' | 'email' })
    }
```

Update the `step.kind === 'verify'` render branch to show method-appropriate copy, still reusing `MfaCodeStep` unchanged:

```tsx
            {step.kind === 'verify' && (
              <MfaCodeStep
                title={step.method === 'sms' ? 'Check your phone' : step.method === 'email' ? 'Check your email' : 'Enter your code'}
                description={
                  step.method === 'sms' ? 'We texted a 6-digit code to your phone. Enter it below.'
                  : step.method === 'email' ? 'We emailed a 6-digit code to you. Enter it below.'
                  : 'Open your authenticator app and enter the current 6-digit code.'
                }
                onSubmit={submitMfaCode}
                onBack={() => setStep({ kind: 'password' })}
              />
            )}
```

(No masked phone/email is threaded through here since the login route's response body never includes it — this is intentional: the response shape stays `{ mfaRequired, mode }` with nothing else, so no destination data leaks to a party who has only guessed a password, even correctly. If a masked destination display is wanted later, that would need the login route to also return e.g. `{ maskedDestination: '•••1234' }`, which is a UX enhancement out of scope for this task.)

- [ ] **Step 8: Run the full test suite for this task's files**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/login.test.ts tests/components/`
Expected: all pass (retry through any transient Neon connectivity errors per the Global Constraints note).

- [ ] **Step 9: Commit**

```bash
git add src/lib/mfa-pending-session.ts src/app/api/login/route.ts src/app/api/login/mfa/route.ts src/app/login/page.tsx src/lib/queries/settings.ts tests/api/login.test.ts
git commit -m "feat: branch staff login MFA challenge/verify on mfaMethod (totp/sms/email)"
```

---

### Task 4: Google OAuth SSO

**Files:**
- Create: `src/lib/google-oauth.ts`
- Create: `src/app/api/auth/google/start/route.ts`
- Create: `src/app/api/auth/google/callback/route.ts`
- Modify: `src/app/login/page.tsx`
- Test: `tests/lib/google-oauth.test.ts`
- Test: `tests/api/auth-google.test.ts`

**Interfaces:**
- Consumes: `setSessionCookie` from `@/lib/auth`; `logAudit` from `@/lib/audit`; `findUserByEmail` from `@/lib/queries/users`.
- Produces: nothing consumed by later tasks (this is the last task before Task 5, which is independent).

- [ ] **Step 1: Write the failing test for PKCE helpers**

Create `tests/lib/google-oauth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generatePkcePair, verifyState } from '@/lib/google-oauth'

describe('generatePkcePair', () => {
  it('produces a verifier and a challenge that is the base64url-SHA256 of the verifier', async () => {
    const { createHash } = await import('crypto')
    const { verifier, challenge } = generatePkcePair()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('produces a different verifier each call', () => {
    const a = generatePkcePair()
    const b = generatePkcePair()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('verifyState', () => {
  it('returns true only when both states match exactly', () => {
    expect(verifyState('abc123', 'abc123')).toBe(true)
    expect(verifyState('abc123', 'abc124')).toBe(false)
    expect(verifyState('abc123', '')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/google-oauth.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/google-oauth.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { jwtVerify, createRemoteJWKSet } from 'jose'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUER_VALUES = ['https://accounts.google.com', 'accounts.google.com']

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null
function getGoogleJwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))
  return _jwks
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function generateState(): string {
  return randomBytes(16).toString('base64url')
}

// Constant-time comparison so a timing side-channel can't help an attacker
// guess the expected state value -- same discipline as password/OTP
// comparisons elsewhere in this codebase.
export function verifyState(expected: string, actual: string): boolean {
  if (!expected || !actual || expected.length !== actual.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge }: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export interface GoogleIdentity {
  sub: string
  email: string
}

/**
 * Exchanges an authorization code for tokens, then verifies the returned ID
 * token's signature against Google's published JWKS (never trusts an
 * unverified JWT's claims) and checks the issuer/audience match this app's
 * client id before returning the identity it asserts.
 */
export async function exchangeCodeForIdentity({ code, codeVerifier, clientId, clientSecret, redirectUri }: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<GoogleIdentity> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '')
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${detail}`)
  }
  const { id_token: idToken } = await tokenRes.json()
  if (!idToken) throw new Error('Google did not return an id_token')

  const { payload } = await jwtVerify(idToken, getGoogleJwks(), { audience: clientId })
  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUER_VALUES.includes(payload.iss)) {
    throw new Error('Unexpected token issuer')
  }
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Google identity token is missing sub/email')
  }

  return { sub: payload.sub, email: payload.email }
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/google-oauth.test.ts`
Expected: PASS (all 3 tests — these are pure functions with no network/DB calls).

- [ ] **Step 5: Write the failing test for the start/callback routes**

Create `tests/api/auth-google.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

describe('GET /api/auth/google/start', () => {
  it('returns 500 with a clear message when Google OAuth env vars are not configured', async () => {
    const originalClientId = process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_ID
    const { GET } = await import('@/app/api/auth/google/start/route')
    const res = await GET(new Request('http://localhost/api/auth/google/start') as never)
    expect(res.status).toBe(500)
    if (originalClientId) process.env.GOOGLE_CLIENT_ID = originalClientId
  })
})

describe('GET /api/auth/google/callback', () => {
  it('rejects when the state does not match the stored cookie', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
    const { GET } = await import('@/app/api/auth/google/callback/route')
    const req = new Request('http://localhost/api/auth/google/callback?code=abc&state=wrong-state', {
      headers: { cookie: 'clinsync_pending_google_oauth=' },
    })
    const res = await GET(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects when no pending OAuth cookie is present at all', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
    const { GET } = await import('@/app/api/auth/google/callback/route')
    const req = new Request('http://localhost/api/auth/google/callback?code=abc&state=some-state')
    const res = await GET(req as never)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/auth-google.test.ts`
Expected: FAIL — the routes don't exist yet.

- [ ] **Step 7: Implement the pending-OAuth cookie helper and the two routes**

Add to `src/lib/mfa-pending-session.ts` (same file, since it already owns the "pending, short-lived, signed" cookie pattern):

```ts
const GOOGLE_OAUTH_COOKIE_NAME = 'clinsync_pending_google_oauth'
const GOOGLE_OAUTH_MAX_AGE_SECONDS = 300

export interface PendingGoogleOAuth {
  state: string
  codeVerifier: string
}

export async function setPendingGoogleOAuthCookie(pending: PendingGoogleOAuth): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-google-oauth', state: pending.state, codeVerifier: pending.codeVerifier })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${GOOGLE_OAUTH_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(GOOGLE_OAUTH_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: GOOGLE_OAUTH_MAX_AGE_SECONDS })
}

export async function getPendingGoogleOAuth(): Promise<PendingGoogleOAuth | null> {
  const store = await cookies()
  const raw = store.get(GOOGLE_OAUTH_COOKIE_NAME)?.value
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, getSessionSecret())
    if (payload.kind === 'pending-google-oauth' && typeof payload.state === 'string' && typeof payload.codeVerifier === 'string') {
      return { state: payload.state, codeVerifier: payload.codeVerifier }
    }
    return null
  } catch {
    return null
  }
}

export async function clearPendingGoogleOAuthCookie(): Promise<void> {
  const store = await cookies()
  store.delete(GOOGLE_OAUTH_COOKIE_NAME)
}
```

Create `src/app/api/auth/google/start/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { generatePkcePair, generateState, buildGoogleAuthUrl } from '@/lib/google-oauth'
import { setPendingGoogleOAuthCookie } from '@/lib/mfa-pending-session'

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!clientId || !appUrl) {
    return NextResponse.json({ error: 'Google sign-in is not configured for this practice yet.' }, { status: 500 })
  }

  const state = generateState()
  const { verifier, challenge } = generatePkcePair()
  await setPendingGoogleOAuthCookie({ state, codeVerifier: verifier })

  const authUrl = buildGoogleAuthUrl({
    clientId,
    redirectUri: `${appUrl}/api/auth/google/callback`,
    state,
    codeChallenge: challenge,
  })
  return NextResponse.redirect(authUrl)
}
```

Create `src/app/api/auth/google/callback/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForIdentity, verifyState } from '@/lib/google-oauth'
import { getPendingGoogleOAuth, clearPendingGoogleOAuthCookie } from '@/lib/mfa-pending-session'
import { setSessionCookie } from '@/lib/auth'
import { findUserByEmail } from '@/lib/queries/users'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'

export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!clientId || !clientSecret || !appUrl) {
    return NextResponse.json({ error: 'Google sign-in is not configured for this practice yet.' }, { status: 500 })
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state) return NextResponse.json({ error: 'Invalid Google sign-in response' }, { status: 400 })

  const pending = await getPendingGoogleOAuth()
  if (!pending || !verifyState(pending.state, state)) {
    return NextResponse.json({ error: 'This sign-in link has expired or is invalid. Please try again.' }, { status: 400 })
  }
  await clearPendingGoogleOAuthCookie()

  let identity
  try {
    identity = await exchangeCodeForIdentity({
      code,
      codeVerifier: pending.codeVerifier,
      clientId,
      clientSecret,
      redirectUri: `${appUrl}/api/auth/google/callback`,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not verify your Google sign-in.' }, { status: 400 })
  }

  const adminEmail = process.env.ADMIN_EMAIL
  if (adminEmail && identity.email.toLowerCase() === adminEmail.toLowerCase()) {
    await setSessionCookie('admin', process.env.ADMIN_NAME ?? 'Admin')
    await logAudit({ role: 'admin', name: process.env.ADMIN_NAME ?? 'Admin' }, 'logged in via Google SSO', null)
    return NextResponse.redirect(`${appUrl}/`)
  }

  // googleSub first (a real link from a prior sign-in), then email as a
  // fallback for a first-ever Google sign-in on an existing account -- never
  // creates a row that doesn't already exist (see spec §5: SSO never
  // auto-provisions staff).
  const [bySub] = await getDb().select().from(users).where(eq(users.googleSub, identity.sub))
  const user = bySub ?? (await findUserByEmail(identity.email))
  if (!user) {
    return NextResponse.json({ error: 'No Clinsync account is linked to this Google account. Ask an admin to add you.' }, { status: 403 })
  }

  if (!bySub) {
    await getDb().update(users).set({ googleSub: identity.sub }).where(eq(users.id, user.id))
  }

  await setSessionCookie(user.role, user.name)
  await logAudit({ role: user.role, name: user.name }, 'logged in via Google SSO', null)
  return NextResponse.redirect(`${appUrl}/`)
}
```

- [ ] **Step 8: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/auth-google.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 9: Write the failing test for the never-auto-provision rule**

Append to `tests/api/auth-google.test.ts`:

```ts
describe('GET /api/auth/google/callback identity matching', () => {
  it('never creates a new user row when no existing account matches the Google identity', async () => {
    vi.doMock('@/lib/google-oauth', () => ({
      exchangeCodeForIdentity: vi.fn(async () => ({ sub: 'nonexistent-google-sub-12345', email: 'no-such-account@example.com' })),
      verifyState: vi.fn(() => true),
    }))
    vi.doMock('@/lib/mfa-pending-session', async () => {
      const actual = await vi.importActual<typeof import('@/lib/mfa-pending-session')>('@/lib/mfa-pending-session')
      return { ...actual, getPendingGoogleOAuth: vi.fn(async () => ({ state: 'x', codeVerifier: 'y' })), clearPendingGoogleOAuthCookie: vi.fn(async () => undefined) }
    })
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'

    const { GET } = await import('@/app/api/auth/google/callback/route')
    const req = new Request('http://localhost/api/auth/google/callback?code=abc&state=x')
    const res = await GET(req as never)
    expect(res.status).toBe(403)

    const { getDb } = await import('@/db/client')
    const { users } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const [found] = await getDb().select().from(users).where(eq(users.email, 'no-such-account@example.com'))
    expect(found).toBeUndefined()
  })
})
```

- [ ] **Step 10: Run it to confirm it fails, then passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/auth-google.test.ts`
Expected: this test should already PASS given Step 7's implementation (it's a confirming test, not one that requires new code) — if it fails, re-check that the callback route's `if (!user)` branch returns before any `getDb().insert(users)` call (there should be no such call anywhere in the route).

- [ ] **Step 11: Add the "Sign in with Google" button to the login page**

In `src/app/login/page.tsx`, inside the `step.kind === 'password'` block, add below the closing `</form>`:

```tsx
                <div className="mt-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground">or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <a
                  href="/api/auth/google/start"
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
                >
                  Sign in with Google
                </a>
```

- [ ] **Step 12: Run `npx tsc --noEmit` and `npx eslint` on all new/changed files**

Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add src/lib/google-oauth.ts src/app/api/auth/google src/lib/mfa-pending-session.ts src/app/login/page.tsx tests/lib/google-oauth.test.ts tests/api/auth-google.test.ts
git commit -m "feat: add Google OAuth SSO for staff login"
```

---

### Task 5: Settings — choosing/switching MFA method

**Files:**
- Create: `src/app/api/account/mfa-method/route.ts`
- Create: `src/components/settings/MfaMethodPicker.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Test: `tests/api/account-mfa-method.test.ts`

**Interfaces:**
- Consumes: `resetUserMfa`, `findUserByEmail` from `@/lib/queries/users`; `resetAdminMfa` from `@/lib/queries/settings`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/account-mfa-method.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PUT } from '@/app/api/account/mfa-method/route'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { hashPassword } from '@/lib/password'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(users).where(eq(users.id, createdIds.pop()!))
})

async function makeSessionCookieFor(name: string, role: 'crc') {
  const { buildSessionCookieValue } = await import('@/lib/auth')
  return buildSessionCookieValue(role, name)
}

describe('PUT /api/account/mfa-method', () => {
  it('rejects switching to sms when no phone is provided and none is on file', async () => {
    const [created] = await getDb().insert(users).values({ name: 'Method Test User', email: 'method-test-user@example.com', role: 'crc', passwordHash: hashPassword('MethodTest123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(created.id)

    const cookie = await makeSessionCookieFor('Method Test User', 'crc')
    const req = new Request('http://localhost/api/account/mfa-method', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: `clinsync_demo_session=${cookie}` },
      body: JSON.stringify({ method: 'sms' }),
    })
    const res = await PUT(req as never)
    expect(res.status).toBe(400)
  })

  it('switches to sms and stores the phone when one is provided', async () => {
    const [created] = await getDb().insert(users).values({ name: 'Method Test User 2', email: 'method-test-user-2@example.com', role: 'crc', passwordHash: hashPassword('MethodTest123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(created.id)

    const cookie = await makeSessionCookieFor('Method Test User 2', 'crc')
    const req = new Request('http://localhost/api/account/mfa-method', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: `clinsync_demo_session=${cookie}` },
      body: JSON.stringify({ method: 'sms', phone: '+15559876543' }),
    })
    const res = await PUT(req as never)
    expect(res.status).toBe(200)

    const [row] = await getDb().select().from(users).where(eq(users.id, created.id))
    expect(row.mfaMethod).toBe('sms')
    expect(row.phone).toBe('+15559876543')
    expect(row.mfaSecretEncrypted).toBeNull()
    expect(row.mfaEnabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/account-mfa-method.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Implement `src/app/api/account/mfa-method/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { users, appSettings } from '@/db/schema'
import { resetUserMfa } from '@/lib/queries/users'
import { getAppSettings, resetAdminMfa } from '@/lib/queries/settings'

const methodSchema = z.object({
  method: z.enum(['totp', 'sms', 'email']),
  phone: z.string().min(1).optional(),
}).strict()

// Switches the CALLING session's own account only -- there's no target
// email/userId in the payload, exactly the same self-service scoping
// discipline as POST /api/account/mfa/reset (the resolved identity is
// always the session's own, never client-supplied).
export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = methodSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  const { method, phone } = parsed.data

  const adminEmail = process.env.ADMIN_EMAIL
  const isAdmin = session.role === 'admin' && adminEmail && session.name === (process.env.ADMIN_NAME ?? 'Admin')

  if (isAdmin) {
    const current = await getAppSettings()
    if (method === 'sms' && !phone && !current.adminPhone) {
      return NextResponse.json({ error: 'A phone number is required to switch to SMS sign-in.' }, { status: 400 })
    }
    await resetAdminMfa()
    await getDb().update(appSettings).set({ adminMfaMethod: method, ...(phone ? { adminPhone: phone } : {}) }).where(eq(appSettings.id, current.id))
    await logAudit(session, `switched MFA method to ${method}`, null)
    return NextResponse.json({ ok: true })
  }

  // session.name is a display name, not an email, for DB users -- resolve
  // the account by matching name+role instead (same best-effort convention
  // already used for doctor/provider matching elsewhere in this codebase,
  // acceptable here since this route only ever mutates the CALLER's own row
  // scoped by their own session, not an arbitrary target).
  const [row] = await getDb().select().from(users).where(eq(users.name, session.name))
  if (!row || row.role !== session.role) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  if (method === 'sms' && !phone && !row.phone) {
    return NextResponse.json({ error: 'A phone number is required to switch to SMS sign-in.' }, { status: 400 })
  }

  await resetUserMfa(row.id)
  await getDb().update(users).set({ mfaMethod: method, ...(phone ? { phone } : {}) }).where(eq(users.id, row.id))
  await logAudit(session, `switched MFA method to ${method}`, null)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/account-mfa-method.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Build the `MfaMethodPicker` component**

Create `src/components/settings/MfaMethodPicker.tsx`:

```tsx
'use client'
import { useState } from 'react'

export function MfaMethodPicker({ currentMethod, currentPhone }: { currentMethod: 'totp' | 'sms' | 'email'; currentPhone: string | null }) {
  const [method, setMethod] = useState(currentMethod)
  const [phone, setPhone] = useState(currentPhone ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    const res = await fetch('/api/account/mfa-method', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, ...(method === 'sms' && phone ? { phone } : {}) }),
    })
    setSaving(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not switch your MFA method.')
      return
    }
    setSaved(true)
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Verification method</p>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1.5"><input type="radio" name="mfaMethod" checked={method === 'totp'} onChange={() => setMethod('totp')} /> Authenticator app</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="mfaMethod" checked={method === 'sms'} onChange={() => setMethod('sms')} /> Text message</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="mfaMethod" checked={method === 'email'} onChange={() => setMethod('email')} /> Email</label>
      </div>
      {method === 'sms' && (
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone number, e.g. +15551234567"
          aria-label="Phone number"
          className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {saved && <p className="text-xs text-success">Saved — you&apos;ll use this method next time you sign in.</p>}
      <button onClick={save} disabled={saving} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
```

- [ ] **Step 6: Wire it into the Settings account tab**

In `src/app/(dashboard)/settings/page.tsx`, find the `accountTab` section (it currently renders `<StaffMfaSelfResetForm email={currentUserEmail} />`). Add the import `import { MfaMethodPicker } from '@/components/settings/MfaMethodPicker'`, fetch the current session's own `mfaMethod`/`phone` the same way the rest of this Server Component fetches `currentUserEmail` (check the existing code just above the `accountTab` definition to find that lookup and follow the same pattern — likely a `findUserByEmail`/`getAdminMfaState`-style call), and render `<MfaMethodPicker currentMethod={currentMfaMethod} currentPhone={currentPhone} />` above the existing `<StaffMfaSelfResetForm />` line.

- [ ] **Step 7: Run `npx tsc --noEmit` and `npx eslint`**

Expected: clean.

- [ ] **Step 8: Run the full test suite for files this plan touched**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/otp-delivery.test.ts tests/lib/google-oauth.test.ts tests/api/auth-google.test.ts tests/api/account-mfa-method.test.ts tests/api/login.test.ts`
Expected: all pass (retry through any transient Neon connectivity errors, falling back to psql verification for anything that stays red, per the Global Constraints note).

- [ ] **Step 9: Commit**

```bash
git add src/app/api/account/mfa-method src/components/settings/MfaMethodPicker.tsx "src/app/(dashboard)/settings/page.tsx" tests/api/account-mfa-method.test.ts
git commit -m "feat: let staff choose/switch their MFA method (authenticator/SMS/email)"
```

---

*After all 5 tasks are complete and the final whole-branch review is clean, use superpowers:finishing-a-development-branch to merge locally — do not push to origin/master without the user's explicit go-ahead each time, per this session's established practice. Real Twilio/SMTP/Google OAuth credentials are a hard dependency the user must provide (see spec §7) before SMS/email/SSO can be exercised end-to-end in production; until then, the `totp` method remains the default and fully functional with zero new external dependencies, exactly as it is today.*
