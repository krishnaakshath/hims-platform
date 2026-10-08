// @vitest-environment node
// Wave J (P1-20): UHID password login and UHID / mobile OTP sign-in for the portal, against
// the real patients table. The send route answers the same for a registered and an unknown
// identifier; the code only goes to the phone on record; a shared mobile, an unprovisioned
// patient or a wrong code never signs anyone in.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { hashPassword } from '@/lib/password'
import { formatUhid } from '@/lib/uhid'

const h = vi.hoisted(() => ({ sendAllowed: true, verifyAllowed: true, codeOk: true }))
vi.mock('@/lib/rate-limit', () => ({
  checkOtpSendRateLimit: vi.fn(async () => ({ allowed: h.sendAllowed })),
  checkOtpVerifyRateLimit: vi.fn(async () => ({ allowed: h.verifyAllowed })),
}))
vi.mock('@/lib/otp-delivery', () => ({
  generateAndSendOtp: vi.fn(async () => undefined),
  verifyOtp: vi.fn(async () => h.codeOk),
}))
vi.mock('@/lib/patient-session', () => ({ setPatientSessionCookie: vi.fn(async () => undefined) }))
vi.mock('@/lib/mfa-pending-session', () => ({ setPendingPatientMfaCookie: vi.fn(async () => undefined) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))

import { POST as sendRoute } from '@/app/api/patient-portal/login/otp/route'
import { POST as verifyRoute } from '@/app/api/patient-portal/login/otp/verify/route'
import { findPortalLoginCandidate } from '@/lib/queries/patient-portal'
import { generateAndSendOtp, verifyOtp } from '@/lib/otp-delivery'
import { checkOtpSendRateLimit } from '@/lib/rate-limit'
import { setPatientSessionCookie } from '@/lib/patient-session'
import { setPendingPatientMfaCookie } from '@/lib/mfa-pending-session'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const TAG = `WJL${process.pid}`
const seq = 90_000_000 + (process.pid % 9_000_000)
const UHID_A = formatUhid('WJ', seq)
const UHID_NOPORTAL = formatUhid('WJ', seq + 1)
const MOBILE_A = `6${String(process.pid).padStart(9, '7').slice(-9)}`
const MOBILE_SHARED = `6${String(process.pid + 1).padStart(9, '3').slice(-9)}`
const IDS = { a: `${TAG}-A`, noPortal: `${TAG}-N`, s1: `${TAG}-S1`, s2: `${TAG}-S2`, mfa: `${TAG}-M` }
const MOBILE_MFA = `6${String(process.pid + 2).padStart(9, '5').slice(-9)}`

const post = (handler: typeof sendRoute, body: unknown) => handler(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9' } }))

beforeAll(async () => {
  const hash = hashPassword('Portal-Pass-123')
  await getDb().insert(patients).values([
    { id: IDS.a, name: 'OTP A', dob: '1980-01-01', uhid: UHID_A, phone: `+91 ${MOBILE_A.slice(0, 5)} ${MOBILE_A.slice(5)}`, portalPasswordHash: hash },
    { id: IDS.noPortal, name: 'OTP N', dob: '1980-01-01', uhid: UHID_NOPORTAL, phone: '+91 9000000000' },
    { id: IDS.s1, name: 'OTP S1', dob: '1980-01-01', phone: MOBILE_SHARED, portalPasswordHash: hash },
    { id: IDS.s2, name: 'OTP S2', dob: '1980-01-01', phone: `0${MOBILE_SHARED}`, portalPasswordHash: hash },
    { id: IDS.mfa, name: 'OTP M', dob: '1980-01-01', phone: MOBILE_MFA, portalPasswordHash: hash, mfaEnabled: true },
  ])
})
afterAll(async () => {
  await getDb().delete(patients).where(inArray(patients.id, Object.values(IDS)))
})
beforeEach(() => {
  h.sendAllowed = true
  h.verifyAllowed = true
  h.codeOk = true
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC-test')
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'token')
  vi.stubEnv('TWILIO_FROM_NUMBER', '+10000000000')
  for (const m of [generateAndSendOtp, verifyOtp, setPatientSessionCookie, setPendingPatientMfaCookie, logPatientPortalAction, checkOtpSendRateLimit]) vi.mocked(m).mockClear()
})

afterEach(() => { vi.unstubAllEnvs() })

describe('password login by UHID', () => {
  it('resolves a UHID in any case to its patient', async () => {
    expect((await findPortalLoginCandidate(UHID_A.toLowerCase()))?.id).toBe(IDS.a)
  })
})

describe('POST /api/patient-portal/login/otp (send)', () => {
  it('sends the code to the phone on record for a UHID or a mobile, keyed to the patient', async () => {
    for (const identifier of [UHID_A.toLowerCase(), `+91 ${MOBILE_A}`]) {
      vi.mocked(generateAndSendOtp).mockClear()
      const res = await post(sendRoute, { identifier })
      expect(res.status).toBe(200)
      expect(generateAndSendOtp).toHaveBeenCalledWith(`patient-portal:${IDS.a}`, 'sms', `+91${MOBILE_A}`)
    }
  })

  it('answers identically, and sends nothing, for an unknown, unprovisioned or shared identifier', async () => {
    const known = await (await post(sendRoute, { identifier: UHID_A })).json()
    vi.mocked(generateAndSendOtp).mockClear()
    for (const identifier of [formatUhid('WJ', seq + 5), UHID_NOPORTAL, MOBILE_SHARED, '9999999999']) {
      const res = await post(sendRoute, { identifier })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(known)
    }
    expect(generateAndSendOtp).not.toHaveBeenCalled()
  })

  it('a failing SMS gateway does not change the answer', async () => {
    vi.mocked(generateAndSendOtp).mockRejectedValueOnce(new Error('Twilio down'))
    const res = await post(sendRoute, { identifier: UHID_A })
    expect(res.status).toBe(200)
  })

  it('is unavailable (503) for everyone when SMS is not configured, before any lookup', async () => {
    vi.stubEnv('TWILIO_FROM_NUMBER', '')
    const res = await post(sendRoute, { identifier: UHID_A })
    expect(res.status).toBe(503)
    expect(checkOtpSendRateLimit).not.toHaveBeenCalled()
  })

  it('rate limited -> 429, nothing sent; a non-identifier -> 400; malformed JSON -> 400', async () => {
    h.sendAllowed = false
    expect((await post(sendRoute, { identifier: UHID_A })).status).toBe(429)
    expect(generateAndSendOtp).not.toHaveBeenCalled()
    h.sendAllowed = true
    expect((await post(sendRoute, { identifier: 'RD-0001' })).status).toBe(400)
    expect((await post(sendRoute, { identifier: UHID_A, password: 'x' })).status).toBe(400)
    const bad = await sendRoute(new NextRequest('http://localhost/x', { method: 'POST', body: '{nope' }))
    expect(bad.status).toBe(400)
  })
})

describe('POST /api/patient-portal/login/otp/verify', () => {
  it('a right code signs the resolved patient in and audits it', async () => {
    const res = await post(verifyRoute, { identifier: `0${MOBILE_A}`, code: '123456' })
    expect(res.status).toBe(200)
    expect(verifyOtp).toHaveBeenCalledWith(`patient-portal:${IDS.a}`, 'sms', '123456')
    expect(setPatientSessionCookie).toHaveBeenCalledWith(IDS.a)
    expect(logPatientPortalAction).toHaveBeenCalledWith('logged in to patient portal with mobile OTP', IDS.a)
  })

  it('a wrong code, an unknown identifier or a shared mobile is the same 401 and no session', async () => {
    h.codeOk = false
    const wrong = await post(verifyRoute, { identifier: UHID_A, code: '000000' })
    h.codeOk = true
    const unknown = await post(verifyRoute, { identifier: formatUhid('WJ', seq + 5), code: '123456' })
    const shared = await post(verifyRoute, { identifier: MOBILE_SHARED, code: '123456' })
    for (const res of [wrong, unknown, shared]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid or expired code' })
    }
    expect(setPatientSessionCookie).not.toHaveBeenCalled()
  })

  it('a patient with an authenticator still has to pass the TOTP step', async () => {
    const res = await post(verifyRoute, { identifier: MOBILE_MFA, code: '123456' })
    expect(await res.json()).toEqual({ mfaRequired: true })
    expect(setPendingPatientMfaCookie).toHaveBeenCalledWith({ patientId: IDS.mfa })
    expect(setPatientSessionCookie).not.toHaveBeenCalled()
  })

  it('rate limited -> 429 before the code is checked; a non-6-digit code -> 400', async () => {
    h.verifyAllowed = false
    expect((await post(verifyRoute, { identifier: UHID_A, code: '123456' })).status).toBe(429)
    expect(verifyOtp).not.toHaveBeenCalled()
    h.verifyAllowed = true
    expect((await post(verifyRoute, { identifier: UHID_A, code: '12345' })).status).toBe(400)
  })
})
