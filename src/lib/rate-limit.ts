import { Ratelimit } from '@upstash/ratelimit'
import { getRedis } from '@/lib/cache'

// Login has no user table to lock out and no CAPTCHA, so this is the only
// brute-force defense on the one admin credential this pilot has. Keyed by
// IP+email (not just IP) so one attacker rotating source IPs against a
// single account is still throttled, while a shared clinic IP with several
// staff logging in isn't punished for someone else's typo.
let _loginLimiter: Ratelimit | null = null
function getLoginLimiter() {
  if (!_loginLimiter) {
    _loginLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '60 s'),
      prefix: 'ratelimit:login',
    })
  }
  return _loginLimiter
}

export async function checkLoginRateLimit(ip: string, email: string): Promise<{ allowed: boolean }> {
  const { success } = await getLoginLimiter().limit(`${ip}:${email.toLowerCase()}`)
  return { allowed: success }
}

// Staff self-service MFA reset (POST /api/account/mfa/reset) re-verifies a
// password, so it's a password-guessing surface exactly like login -- and a
// more dangerous one: someone holding a stolen staff session who guesses the
// real password there can clear MFA, then log in fresh and enroll their own
// authenticator, turning a temporary session hijack into a permanent
// takeover. Same 5-per-60s per-IP window as checkLoginRateLimit, in its own
// bucket (so it never shares a counter with real logins), plus the same
// IP-independent backstop the other dual-bucket limiters use: the per-IP key
// trusts the client-supplied x-forwarded-for header, so without the
// identity-only bucket an attacker could rotate a spoofed IP per guess.
// Keyed on the submitted email (lowercased), since the route doesn't yet
// know which branch (env admin vs DB user) that email resolves to when it
// has to decide whether to allow the attempt.
let _accountMfaResetLimiter: Ratelimit | null = null
function getAccountMfaResetLimiter() {
  if (!_accountMfaResetLimiter) {
    _accountMfaResetLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '60 s'),
      prefix: 'ratelimit:account-mfa-reset',
    })
  }
  return _accountMfaResetLimiter
}

let _accountMfaResetGlobalLimiter: Ratelimit | null = null
function getAccountMfaResetGlobalLimiter() {
  if (!_accountMfaResetGlobalLimiter) {
    _accountMfaResetGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(10, '600 s'),
      prefix: 'ratelimit:account-mfa-reset-global',
    })
  }
  return _accountMfaResetGlobalLimiter
}

export async function checkAccountMfaResetRateLimit(ip: string, email: string): Promise<{ allowed: boolean }> {
  const identity = email.toLowerCase()
  const [perIp, global] = await Promise.all([
    getAccountMfaResetLimiter().limit(`${ip}:${identity}`),
    getAccountMfaResetGlobalLimiter().limit(identity),
  ])
  return { allowed: perIp.success && global.success }
}

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

// A second, IP-independent bucket keyed on identity alone: the per-IP
// limiter above trusts the client-supplied `x-forwarded-for` header (see
// getClientIp in the login routes), so an attacker can get a fresh 5-attempt
// budget on every single guess just by sending a different spoofed IP each
// time -- no botnet needed, just a header change per request. This catches
// sustained TOTP guessing against one staff account regardless of how many
// (real or spoofed) IPs it comes from. Slower and wider than the per-IP
// bucket -- it's the backstop, not the primary defense, and shouldn't lock
// out a staff member's own handful of mistyped codes. Same shape as
// checkPatientLoginRateLimit's dual-bucket defense against the identical
// threat model.
let _staffMfaGlobalLimiter: Ratelimit | null = null
function getStaffMfaGlobalLimiter() {
  if (!_staffMfaGlobalLimiter) {
    _staffMfaGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(10, '600 s'),
      prefix: 'ratelimit:mfa-verify-staff-global',
    })
  }
  return _staffMfaGlobalLimiter
}

export async function checkStaffMfaRateLimit(ip: string, identity: string): Promise<{ allowed: boolean }> {
  const [perIp, global] = await Promise.all([
    getStaffMfaLimiter().limit(`${ip}:${identity}`),
    getStaffMfaGlobalLimiter().limit(identity),
  ])
  return { allowed: perIp.success && global.success }
}

// Same defense, separate bucket -- a patient hammering their own portal
// login (or an attacker guessing patient IDs) must never be able to affect
// or be affected by the staff login limiter's counters.
let _patientLoginLimiter: Ratelimit | null = null
function getPatientLoginLimiter() {
  if (!_patientLoginLimiter) {
    _patientLoginLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '60 s'),
      prefix: 'ratelimit:patient-login',
    })
  }
  return _patientLoginLimiter
}

// A second, IP-independent bucket keyed on patientId alone: the per-IP
// limiter above is defeated by an attacker rotating source addresses (a
// real risk for `x-forwarded-for`-derived IPs, which aren't authenticated),
// so this catches sustained guessing against one patient account regardless
// of how many IPs it comes from. Slower and wider than the per-IP bucket --
// it's the backstop, not the primary defense, and shouldn't lock out a
// patient's own handful of real typos.
let _patientLoginGlobalLimiter: Ratelimit | null = null
function getPatientLoginGlobalLimiter() {
  if (!_patientLoginGlobalLimiter) {
    _patientLoginGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(10, '600 s'),
      prefix: 'ratelimit:patient-login-global',
    })
  }
  return _patientLoginGlobalLimiter
}

export async function checkPatientLoginRateLimit(ip: string, identifier: string): Promise<{ allowed: boolean }> {
  // `identifier` is a patient ID or (portal login) an email. Key on the
  // trimmed, lowercased form so case/whitespace variants of one identifier
  // ("Name@X.com", " name@x.com ", "rd-0001") share a bucket and never buy an
  // attacker extra attempts. Over-merging is safe: it can only make the
  // limiter stricter, never looser, than the exact-case credential lookup.
  const key = identifier.trim().toLowerCase()
  const [perIp, global] = await Promise.all([
    getPatientLoginLimiter().limit(`${ip}:${key}`),
    getPatientLoginGlobalLimiter().limit(key),
  ])
  return { allowed: perIp.success && global.success }
}

// Separate bucket from the password-check limiter above -- same reasoning as
// checkStaffMfaRateLimit: a correct password shouldn't share a counter with
// brute-forcing the 6-digit TOTP code that comes after it.
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

// A second, IP-independent bucket keyed on identity alone -- same defense as
// checkStaffMfaRateLimit's global bucket, against the identical threat model:
// the per-IP limiter above trusts the client-supplied `x-forwarded-for`
// header (see getClientIp in the login routes), so an attacker can get a
// fresh 5-attempt budget on every single guess just by sending a different
// spoofed IP each time. This catches sustained TOTP guessing against one
// patient account regardless of how many (real or spoofed) IPs it comes
// from. Slower and wider than the per-IP bucket -- it's the backstop, not
// the primary defense, and shouldn't lock out a patient's own handful of
// mistyped codes.
let _patientMfaGlobalLimiter: Ratelimit | null = null
function getPatientMfaGlobalLimiter() {
  if (!_patientMfaGlobalLimiter) {
    _patientMfaGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(10, '600 s'),
      prefix: 'ratelimit:mfa-verify-patient-global',
    })
  }
  return _patientMfaGlobalLimiter
}

export async function checkPatientMfaRateLimit(ip: string, patientId: string): Promise<{ allowed: boolean }> {
  const [perIp, global] = await Promise.all([
    getPatientMfaLimiter().limit(`${ip}:${patientId}`),
    getPatientMfaGlobalLimiter().limit(patientId),
  ])
  return { allowed: perIp.success && global.success }
}

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

// GET /api/queue-display is unauthenticated (PIN-gated, not session-gated --
// spec §3) but is still a secret-checking endpoint like every limiter above,
// so it gets the same defense. Unlike those, there's no per-account identity
// to key a second bucket on -- a lobby TV has no email/patientId, just an
// IP -- so this is a single per-IP bucket. Sized well above the display
// page's own 8s polling cadence (~8 requests/min for one device, plus room
// for a page reload or a second device behind the same router/NAT), while
// still cutting off a brute-force PIN-guessing script hard.
let _queueDisplayPinLimiter: Ratelimit | null = null
function getQueueDisplayPinLimiter() {
  if (!_queueDisplayPinLimiter) {
    _queueDisplayPinLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(20, '60 s'),
      prefix: 'ratelimit:queue-display-pin',
    })
  }
  return _queueDisplayPinLimiter
}

export async function checkQueueDisplayPinRateLimit(ip: string): Promise<{ allowed: boolean }> {
  const { success } = await getQueueDisplayPinLimiter().limit(ip)
  return { allowed: success }
}

// The public booking-request route has no session and no credential to
// guess -- an anonymous submitter has no persistent identity before they
// submit, so unlike every other dual-bucket limiter in this file, there's
// nothing to key a global bucket on except a single fixed string. That makes
// this global bucket a genuinely flat, shared cap on total booking
// submissions across the whole app regardless of source IP, defending
// against a botnet rotating (or spoofing) addresses to dodge the per-IP
// bucket. Tighter than login's 5-per-60s: this gates a lower-frequency
// legitimate action (nobody submits multiple real booking requests per
// minute), so the per-IP window is 3-per-300s.
//
// The global backstop itself was originally 20-per-600s, but -- unlike
// every other bucket in this file -- it isn't keyed on any identity, so
// that cap is shared by every legitimate patient across the whole practice
// at once. A single trivial actor (no botnet needed, just one script making
// 20 requests) could burn the entire bucket in seconds and then 429 every
// real patient for the practice for the next 10 minutes. Raised to
// 200-per-600s: still a real hard backstop against a genuine bot/DDoS burst
// (200 submissions in 10 minutes is far outside plausible organic volume
// for one practice's public booking widget), but no longer trivially
// exhausted by ordinary legitimate traffic or a single bad actor.
let _bookingRequestLimiter: Ratelimit | null = null
function getBookingRequestLimiter() {
  if (!_bookingRequestLimiter) {
    _bookingRequestLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(3, '300 s'),
      prefix: 'ratelimit:booking-request',
    })
  }
  return _bookingRequestLimiter
}

let _bookingRequestGlobalLimiter: Ratelimit | null = null
function getBookingRequestGlobalLimiter() {
  if (!_bookingRequestGlobalLimiter) {
    _bookingRequestGlobalLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(200, '600 s'),
      prefix: 'ratelimit:booking-request-global',
    })
  }
  return _bookingRequestGlobalLimiter
}

export async function checkBookingRequestRateLimit(ip: string): Promise<{ allowed: boolean }> {
  const [perIp, global] = await Promise.all([
    getBookingRequestLimiter().limit(ip),
    getBookingRequestGlobalLimiter().limit('global'),
  ])
  return { allowed: perIp.success && global.success }
}

// Wave J (P1-20): appointment requests from the patient portal. The caller is already
// authenticated, so the bucket is keyed on the session's patient id alone (an IP adds
// nothing an attacker could not rotate). Generous for a real patient -- a handful of
// requests an hour -- while stopping a script from flooding the staff booking queue.
let _portalAppointmentRequestLimiter: Ratelimit | null = null
function getPortalAppointmentRequestLimiter() {
  if (!_portalAppointmentRequestLimiter) {
    _portalAppointmentRequestLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '3600 s'),
      prefix: 'ratelimit:portal-appointment-request',
    })
  }
  return _portalAppointmentRequestLimiter
}

export async function checkPortalAppointmentRequestRateLimit(patientId: string): Promise<{ allowed: boolean }> {
  const { success } = await getPortalAppointmentRequestLimiter().limit(patientId)
  return { allowed: success }
}
// end Wave J

// Test-only escape hatch. Every other bucket in this file is keyed on a
// per-test-random identity, so exhausting one only ever affects that one
// test. This global bucket is the one exception -- its key is the literal
// string 'global', shared by every caller including production traffic and
// every test file -- so a test that deliberately saturates it (proving the
// flat cap works) would otherwise leak a ~600s-long false 429 into any other
// suite that hits checkBookingRequestRateLimit afterward, with the ordering
// entirely up to file discovery order rather than anything meaningful. Call
// this from an afterAll in the test that saturates the bucket so it can
// never do that regardless of run order.
export async function __resetBookingRequestGlobalBucketForTests(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetBookingRequestGlobalBucketForTests must never be called in production')
  }
  await getBookingRequestGlobalLimiter().resetUsedTokens('global')
}
