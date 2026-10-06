# Authentication Hardening — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** second sub-project of the HIMS expansion, after Front Desk / Reception (merged into master). Requested directly: "otp auth through mobile number or smtp or even otp auth through authenticator or also sso as well we need to make this more secure since this is confidential data."

## 1. What this is

Clinsync's staff login already has mandatory TOTP (authenticator-app) MFA — real, working, replay-protected (`src/lib/mfa.ts`, `src/app/api/login/mfa/route.ts`). This spec adds three more ways to satisfy the second factor, so a practice isn't forced to require every staff member to install an authenticator app:

1. **SMS OTP** — a 6-digit code texted to the staff member's phone.
2. **Email OTP** — a 6-digit code emailed via SMTP (using real mail credentials the practice already has — Gmail/Workspace/Office 365/any SMTP host — not a new third-party account).
3. **SSO (Google OAuth 2.0)** — "Sign in with Google," which replaces password+MFA entirely for that login (the OAuth flow itself is the strong factor).

Each staff account picks **one** MFA method (not all three at once) — this mirrors how virtually every real product handles multi-method 2FA (Settings lets you switch methods; switching invalidates the old method's secret). Google SSO is different: a staff account either signs in with Google every time, or it doesn't — there's no "pick SSO as your MFA method" concept, since it's a separate top-level sign-in path shown as its own button on `/login`.

**Explicitly not simulated, unlike the rest of this app's mocked integrations:** SMS/email delivery and the Google OAuth flow are real. A fake 2FA flow that doesn't actually verify anything would be actively dangerous, not an honest simulation — there's no safe way to "mock" an authentication factor the way `tebra.mock.ts` mocks a read-only data source. This means the practice must provide real credentials before these methods work (see §7).

**Explicitly out of scope:** patient-portal MFA method changes (this spec covers staff login only — the patient portal keeps its existing TOTP-only MFA); WorkOS or any other multi-tenant enterprise SSO broker (Google OAuth is the one reference implementation for now); Microsoft/Apple/other OAuth providers (structured so one could be added later, not built now).

## 2. Data model changes (additive only)

```ts
export const mfaMethodEnum = pgEnum('mfa_method', ['totp', 'sms', 'email'])
```

Add to `users` table:
- `mfaMethod: mfaMethodEnum('mfa_method').default('totp').notNull()`
- `phone: text('phone')` — required only when `mfaMethod = 'sms'`; nullable otherwise.
- `googleSub: text('google_sub')` — the stable Google account identifier (the OAuth `sub` claim), set the first time a user signs in via Google for that account; nullable. Used to match a returning Google sign-in back to the right `users` row without re-trusting email alone (an email can be reassigned; a `sub` cannot).

Add equivalent `mfaMethod`/`phone` columns to `app_settings` for the env-based admin account (mirroring the existing `adminMfaSecretEncrypted`/`adminMfaEnabled` pair): `adminMfaMethod`, `adminPhone`. Admin does not get `googleSub` — the admin account's identity is the `ADMIN_EMAIL` env var, not a `users` row, and SSO sign-in creates/matches only real `users` rows (see §5).

No existing column is altered. `mfaSecretEncrypted`/`mfaEnabled` (and the admin equivalents) keep their current meaning for the `totp` method; SMS/email OTP codes are never stored in Postgres at all (see §3 — they live only in Redis, same TTL-based ephemeral pattern already used for MFA replay protection).

## 3. SMS and Email OTP delivery

**One shared code-generation/verification module**, `src/lib/otp-delivery.ts`:

```ts
export async function generateAndSendOtp(identity: string, channel: 'sms' | 'email', destination: string): Promise<void>
export async function verifyOtp(identity: string, channel: 'sms' | 'email', code: string): Promise<boolean>
```

- `generateAndSendOtp` creates a random 6-digit code (`crypto.randomInt(100000, 999999)`), stores its SHA-256 hash in Redis at `otp:${channel}:${identity}` with a 5-minute TTL (`getRedis().set(key, hash, { ex: 300 })` — same `getRedis()` helper already used by `src/lib/mfa.ts`), and sends it via the channel-specific sender (`sendSms`/`sendEmail`, below). Never logs the plaintext code anywhere, including audit log entries.
- `verifyOtp` hashes the submitted code, compares against the stored hash (`timingSafeEqual`, same discipline as `src/lib/password.ts`), and deletes the Redis key on a successful match (single-use, same intent as TOTP's replay guard but simpler since there's no time-window to reason about — the code either matches the one stored value or it doesn't).
- Rate limiting reuses `src/lib/rate-limit.ts`'s existing pattern: at most 5 send attempts per identity per 15 minutes, at most 5 verify attempts per identity per 15 minutes (separate buckets, so a burst of failed verifies doesn't also lock out resend).

`src/lib/sms.ts`:
```ts
export async function sendSms(toPhone: string, code: string): Promise<void>
```
Calls Twilio's REST API directly via `fetch` (no SDK dependency needed — Twilio's send-message endpoint is a single authenticated POST): `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, Basic Auth with `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, body `{ To: toPhone, From: TWILIO_FROM_NUMBER, Body: 'Your Clinsync verification code is ${code}. It expires in 5 minutes.' }`. Throws a clear, caught-by-the-caller error if any of the three required env vars are missing, rather than silently no-opping — a practice that hasn't configured SMS shouldn't be able to accidentally let a user "verify" with no code ever sent.

`src/lib/email.ts`:
```ts
export async function sendEmail(toEmail: string, subject: string, body: string): Promise<void>
```
Uses `nodemailer` (new dependency — see §7) configured from `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM` env vars. Same fail-loud-if-unconfigured behavior as `sendSms`.

## 4. Login flow integration

The existing two-step flow (`POST /api/login` → password check → `startStaffMfaChallenge` → `POST /api/login/mfa` → code check → real session) is extended, not replaced:

- `startStaffMfaChallenge` (in `src/app/api/login/route.ts`) branches on the account's `mfaMethod`:
  - `totp` (default, unchanged): today's enroll-or-verify QR/code flow.
  - `sms`: calls `generateAndSendOtp(identity, 'sms', user.phone)`, sets the same `PendingStaffMfaSession` cookie with a new `method: 'sms'` field, returns `{ mfaRequired: true, mode: 'sms' }` (no QR code, no secret — the frontend shows "Enter the code we texted you").
  - `email`: same as `sms` but `generateAndSendOtp(identity, 'email', user.email)`, `{ mfaRequired: true, mode: 'email' }`.
- `POST /api/login/mfa` branches the verification step the same way: `totp` calls the existing `verifyMfaCode`; `sms`/`email` call `verifyOtp(identity, pending.method, code)` instead of touching `mfaSecretEncrypted` at all.
- The `/login` page's MFA-entry screen shows method-appropriate copy ("Enter the 6-digit code from your authenticator app" vs. "...we texted to your phone ending in ••••1234" vs. "...we emailed to j***@example.com") — never the full phone/email, to avoid leaking it to anyone glancing at a shared screen.

## 5. Google SSO

A separate, parallel sign-in path — not a "4th MFA method," since OAuth replaces the password+MFA step entirely for that login:

- `/login` gets a "Sign in with Google" button alongside the existing email/password form.
- `GET /api/auth/google/start` — generates a random `state` (CSRF protection) and a PKCE `code_verifier`/`code_challenge` pair, stores both in a short-lived signed cookie (same `jose` HS256 pattern as `mfa-pending-session.ts`, 5-minute TTL), and redirects to Google's authorization endpoint (`https://accounts.google.com/o/oauth2/v2/auth`) with `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `state`, `code_challenge`, `code_challenge_method=S256`.
- `GET /api/auth/google/callback` — verifies `state` matches the cookie, exchanges the authorization `code` for tokens at Google's token endpoint (`https://oauth2.googleapis.com/token`, including the `code_verifier`), decodes the returned ID token's `sub`/`email` claims (verify the ID token's signature via Google's published JWKS — do not trust an unverified JWT), then:
  - Looks up a `users` row by `googleSub` first, then by `email` if no `googleSub` match (linking that row's `googleSub` on first successful Google sign-in for that email).
  - If no matching `users` row exists at all, reject with a clear error ("No Clinsync account is linked to this Google account — ask an admin to add you") — **SSO never auto-creates a new staff account**, consistent with `POST /api/users` already being the only sanctioned way to provision staff.
  - On a match, calls `setSessionCookie(user.role, user.name)` directly — no MFA step, since a verified Google identity already is the second factor — and `logAudit(session, 'logged in via Google SSO', null)`.
- The env-based admin account (`ADMIN_EMAIL`) can also sign in via Google if the returned email matches `ADMIN_EMAIL` exactly — same as the password path treating admin as special-cased before touching the `users` table.

## 6. Settings: choosing/switching MFA method

`src/components/settings/StaffManagementPanel.tsx`'s existing per-account view (or the current user's own Account settings, `PUT /api/account/mfa` equivalent) gets a method picker: `totp` / `sms` / `email`. Switching method:
1. Clears the old method's stored secret (`mfaSecretEncrypted = NULL, mfaEnabled = false` for a switch away from `totp`; nothing stored server-side to clear for `sms`/`email` since those never persist a secret).
2. For a switch to `sms`, requires a `phone` to already be on file (prompts for one if missing) before the switch takes effect.
3. Sets `mfaMethod` to the new value — the next login re-triggers enrollment-equivalent behavior for that method (first `sms`/`email` login just sends a code immediately, since there's no "enrollment" concept for a per-login OTP; first `totp` login after switching back still shows a fresh QR).
Reuses the existing `reset-mfa` admin action (`src/app/api/users/[id]/reset-mfa/route.ts`) as the "force this user to re-pick a method" escape hatch — no new route needed for that specific action.

## 7. What the practice must provide (real credentials, not simulated)

New required env vars, following the exact same "generate/obtain, then `vercel env add`" pattern already documented in the README for `ADMIN_PASSWORD_HASH`/`IDENTITY_ENCRYPTION_KEY`:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — from a Twilio account (a free trial account works for testing; sending to unverified numbers requires a paid account).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` — from any SMTP-capable mailbox the practice already has.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from a Google Cloud OAuth 2.0 client (a few minutes to create in Google Cloud Console; needs the callback URL registered as an authorized redirect URI).

**Until these are set, `sms`/`email` MFA methods and the Google SSO button must fail loudly and safely, never silently degrade to "no verification required."** If `TWILIO_ACCOUNT_SID` etc. are absent, `sendSms` throws, the login route catches it and returns a clear 500-with-message ("SMS sign-in isn't configured for this practice yet — contact your admin") rather than letting the flow continue unauthenticated. Same for email/Google. `totp` remains the always-available default with zero external dependencies, exactly as it is today — a practice that never configures any of the above loses nothing.

## 8. New dependency

`nodemailer` (for SMTP email sending) — no SDK needed for Twilio (plain `fetch` to its REST API, per §3) or Google OAuth (plain `fetch` to Google's documented endpoints, no `google-auth-library` needed for a single-provider authorization-code+PKCE flow).

## 9. Testing focus (Review Focus)

1. **A staff account with no `phone`/no `SMTP_HOST` configured switches to `sms`/`email`** — must be blocked at the switch step (§6.2) or fail loudly at send time (§7), never silently accept a login with no code ever delivered.
2. **Google sign-in with an email/sub that matches no `users` row** — must reject cleanly, never auto-provision a new staff account.
3. **OAuth `state` mismatch or a replayed/expired PKCE cookie** — must reject the callback, not silently proceed with an unverified flow (this is the CSRF protection the whole PKCE dance exists for).
4. **OTP code reuse** — a code that was already verified once must be rejected on a second submission (Redis key deleted on first success), same replay-safety property TOTP already has.
5. **Rate limiting on OTP send/verify** — a burst of resend requests must not let someone brute-force a 6-digit code within its 5-minute window (5 attempts per 15 minutes per identity, per §3, makes an exhaustive 6-digit search infeasible).

---

*Next step: user reviews this spec. On approval, this spec's implementation plan is written via the writing-plans skill — not before. Real external credentials (Twilio/SMTP/Google OAuth) are a hard dependency the user must provide before the corresponding features can be exercised end-to-end; implementation and tests can proceed using clearly-fake placeholder credentials that exercise the fail-loudly path until real ones are supplied.*
