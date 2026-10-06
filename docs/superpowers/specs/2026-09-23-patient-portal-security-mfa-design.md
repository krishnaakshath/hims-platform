# Patient-Portal Security: TOTP MFA + Patient Auto-Logoff

**Status:** design drafted, pending your review before an implementation plan is written.
**Sub-project 1 of 8** from the decomposition of `docs/product-review-and-gap-analysis.md`'s
buildable-now gaps. The other seven (questionnaire auto-scoring, scheduled reminders, public
booking, e-signatures, care plans/lab results, ToS/NPP acceptance, AI-assisted charting) are
each their own design → spec → plan cycle, done one at a time, not together.

## 0. Decisions already made (confirmed in conversation before this doc)

- Covers **both** staff and patient logins — HIPAA's technical-safeguards ask covers both.
- Second factor: **TOTP only**, right now. Email/SMS OTP need a real provisioned
  email/SMS provider (a real account, real cost) — explicitly a fast-follow, not this project.
  No `mfaMethod` column is added for a hypothetical future method; when email/SMS actually get
  built, that's the time to add one.
- MFA is **mandatory for staff**, **optional (opt-in) for patients**.
- **No existing credential changes.** Admin env-var credentials, staff `passwordHash` rows,
  patient portal passwords, `SESSION_SECRET`, `IDENTITY_ENCRYPTION_KEY` — none of this is
  touched, rotated, or migrated. MFA is a second, additive layer on top of the password check
  that exists today, never a replacement for it.

## 1. The gap this closes

From the gap analysis: patient-portal sessions have no idle-timeout equivalent to staff's
`SessionTimeoutWarning`, and MFA is "confirmed absent" everywhere, including in the code's own
comment on `patient-session.ts` (*"no 'remember this device', no MFA"*).

## 2. A real wrinkle the original design missed: the admin account has no DB row

`src/app/api/login/route.ts` authenticates the admin via `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`
env vars, checked *before* the `users` table lookup, and never touches a `users` row. "Mandatory
MFA for staff" therefore can't live purely in `users.mfaSecretEncrypted`/`mfaEnabled` — there's
no row for admin to hang those columns off. Fix: store admin's MFA state on `appSettings`
(already the pilot's one singleton config row) as `adminMfaSecretEncrypted`/`adminMfaEnabled`,
and give the login route's admin branch and DB-user branch symmetric MFA handling — same shape,
different storage location, exactly mirroring how the route already branches today.

## 3. Login flow (both staff and patient)

Two-step login, reusing the existing `jose`/`SESSION_SECRET` JWT infrastructure — no new signing
mechanism, no new cookie-signing scheme.

**Step 1 — password check (existing routes, extended):**
`POST /api/login` and `POST /api/patient-portal/login` do exactly what they do today first. If
the credential is valid:
- **Patient without MFA enabled:** unchanged — real session cookie set immediately, `{ok:true}`.
  This is the entire behavior change for the common patient case: none.
- **Staff (always, once this ships) or a patient who has opted in, and MFA not yet enrolled**
  (staff only — a patient can only reach "enabled" by finishing enrollment already, so this
  branch is staff-only in practice): generate a TOTP secret now, store it encrypted
  (`mfaEnabled` stays `false` — "provisioned but unconfirmed"), mint a 5-minute signed pending
  JWT in an httpOnly cookie, respond `{mfaRequired: true, mode: 'enroll', qrDataUrl, manualKey}`.
- **MFA already enabled:** mint the same pending-JWT cookie, respond
  `{mfaRequired: true, mode: 'verify'}` — no secret material in the response.

**Step 2 — code check (new routes):** `POST /api/login/mfa` and
`POST /api/patient-portal/login/mfa`, body `{code}`. Reads the pending cookie, decrypts the
stored secret (`lib/crypto.ts`, the same AES-256-GCM helper already protecting ID numbers — no
new crypto), validates with `otpauth`'s `TOTP.validate({token, window: 1})` (±30s drift
tolerance). On success: if this was an enrollment, flip `mfaEnabled` to `true`; clear the
pending cookie; set the real session cookie (`setSessionCookie`/`setPatientSessionCookie`,
untouched); write an audit entry (`logAudit`/`logPatientPortalAction`, reusing the existing
functions — the pending JWT carries enough identity to construct the same `Session` shape those
already expect). On failure: generic error, pending cookie survives so the user can retry within
the 5-minute window, and the attempt is rate-limited (new `@upstash/ratelimit` buckets,
`ratelimit:mfa-verify-staff` / `ratelimit:mfa-verify-patient`, same 5-per-60s sliding window
shape as the existing login limiters in `lib/rate-limit.ts`, keyed `ip:identity` so it can never
share a bucket with the password-check limiters).

## 4. Enrollment, opt-in, and reset — one mechanism, three entry points

Rather than building a separate "enroll from Settings" UI in addition to the login-time
enrollment screen, opt-in and re-enrollment reuse the *same* QR/confirm component the mandatory
staff flow uses, and "reset" is just "clear the flags, so the next login/opt-in re-enrolls."

- **Staff, first mandatory login:** the Step-1→Step-2 flow above. No separate Settings entry
  point needed — staff never sees an "enable MFA" toggle, only a status + reset.
- **Patient, opt-in:** a new **Security** page in the patient portal
  (`src/app/patient-portal/(authenticated)/security/page.tsx`, added to
  `PatientPortalSideNav`) with an "Enable two-factor authentication" action. Since the patient
  already holds a full session here (not a pending one), this calls dedicated
  `POST /api/patient-portal/account/mfa/enroll` (generate+store unconfirmed secret, return
  QR+manual key) then `POST /api/patient-portal/account/mfa/confirm` (`{code}`, flips
  `mfaEnabled`) — same validation and audit-logging path as step 2 above, just against the real
  session instead of a pending one.
- **Reset (staff, self-service — lost-device recovery while still holding a trusted-device
  session):** Settings → Account tab gets a small "Security" section showing MFA status and a
  "Reset my MFA" button. Requires re-entering `{email, password}` — re-verified exactly like a
  fresh login (admin against env vars, DB users against `users.passwordHash`), and the
  resulting identity is checked against the caller's own session (`role`+`name`) before
  anything is cleared, so this can only ever reset *your own* MFA, not disable a check on
  someone else's account via a name collision. Clears the secret + `mfaEnabled`; next login
  re-enrolls. This is also how **admin** recovers a lost device — no separate "admin resets
  admin" mechanism is needed, since password re-entry alone is already the recovery credential.
- **Reset (patient, self-service — also doubles as "turn MFA back off"):**
  `POST /api/patient-portal/account/mfa/reset` on the new Security page, same
  `{patientId, password}` re-auth shape as patient login.
- **Reset (admin-triggered, for someone who can't log in at all):** `StaffManagementPanel` gets
  a "Reset MFA" button per row next to existing account info (admin-only, mirrors the existing
  `isAdmin`-gated "Add Staff Member" pattern) → `POST /api/users/[id]/reset-mfa`.
  `PatientPortalAccessPanel` gets a "Reset MFA" button next to the existing "Revoke access"
  control (same admin-only gating) → `POST /api/patients/[id]/reset-mfa`. Both clear the
  target's secret + `mfaEnabled` and audit-log the action against the *admin's* session (not
  the target's), matching how `revokePatientPortalAccess()` is already attributed today.

## 5. Patient-portal auto-logoff

A direct, same-numbers port of `SessionTimeoutWarning` (10 min idle warning, 12 min forced
logout) into the patient portal's authenticated layout
(`src/app/patient-portal/(authenticated)/layout.tsx`), calling the existing
`/api/patient-portal/logout` route instead of `/api/logout`. No new behavior beyond what staff
sessions already have — this closes the exact asymmetry the gap-analysis doc flagged.

## 6. Data model

Additive columns only, applied via a **hand-written SQL throwaway script**, never
`drizzle-kit push` — per this project's standing rule
(`docs/ehr-platform-architecture.md:83`, re-confirmed here since this is exactly that kind of
change):

```sql
ALTER TABLE users    ADD COLUMN mfa_secret_encrypted text;
ALTER TABLE users    ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN mfa_secret_encrypted text;
ALTER TABLE patients ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN admin_mfa_secret_encrypted text;
ALTER TABLE app_settings ADD COLUMN admin_mfa_enabled boolean NOT NULL DEFAULT false;
```

Matching `schema.ts` field additions on `users`, `patients`, `appSettings`.

## 7. New dependencies

- `otpauth` — TOTP secret generation, `otpauth://` URI construction, code validation. Pure JS,
  no native bindings, no external service calls.
- `qrcode` — renders the `otpauth://` URI to a data-URL PNG server-side for the enrollment
  screen. Pure JS, no native bindings.

Both are small, actively maintained, and match the project's existing preference (`jose` for
JWTs, `zod` for validation) for dependency-light, self-contained libraries over anything that
calls out to a third-party service.

## 8. Testing

Matches `tests/api/*.test.ts` conventions (see `tests/api/login.test.ts`'s `@vitest-environment
node` + jose/jsdom note, which applies to every new route here too):
- Unit tests for TOTP enroll/validate helpers (valid code, expired/wrong code, replay within
  the validation window) and for the admin-vs-DB-user branching.
- Route tests for both login flows' new response shapes: password-only success (patient, no
  MFA), enroll-required, verify-required, wrong code, expired pending token, rate-limit 429.
- Route tests for both self-service reset endpoints (correct re-auth succeeds, wrong password
  rejected, cross-account reset rejected) and both admin-triggered reset endpoints
  (non-admin rejected, admin succeeds, audit entry attributed to the admin).

## 9. Explicitly out of scope here (fast-follow or separate project)

- Email/SMS OTP as a second MFA method.
- "Remember this device" / trusted-device skipping of the TOTP step.
- Backup/recovery codes (the password-re-auth reset *is* this project's recovery path).
- Any change to how the admin, staff, or patient *password* credential itself is created,
  verified, or rotated.
