// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// Pure/unit: every DB, Redis, SMTP and Twilio dependency is mocked. Each test
// stubs BRAND_* env, resets the module graph, and re-imports the real modules
// so they pick up the brand exactly as a fresh server process would.

const cookieWrites = vi.hoisted(() => [] as string[])

function mockInfra() {
  cookieWrites.length = 0
  vi.doMock('next/headers', () => ({
    cookies: async () => ({
      get: () => undefined,
      set: (name: string) => { cookieWrites.push(name) },
      delete: (name: string) => { cookieWrites.push(`delete:${name}`) },
    }),
  }))
  vi.doMock('@/db/client', () => ({ getDb: vi.fn(() => { throw new Error('no DB in unit tests') }) }))
  vi.doMock('@/lib/cache', () => ({ getRedis: () => ({ set: vi.fn(async () => 'OK'), get: vi.fn(async () => null), del: vi.fn(async () => 1) }) }))
  vi.doMock('qrcode', () => ({ default: { toDataURL: vi.fn(async (uri: string) => `qr:${uri}`) } }))
  vi.doMock('@/lib/email', () => ({ sendEmail: vi.fn(async () => undefined) }))
}

async function withBrand(env: Record<string, string>) {
  vi.stubEnv('SESSION_SECRET', 'unit-test-only-secret-not-a-real-value-0123456789')
  for (const k of ['BRAND_NAME', 'BRAND_COOKIE_PREFIX', 'BRAND_LEGAL_NAME']) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  mockInfra()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.doUnmock('next/headers')
  vi.doUnmock('@/db/client')
  vi.doUnmock('@/lib/cache')
  vi.doUnmock('qrcode')
  vi.doUnmock('@/lib/email')
  vi.resetModules()
})

const CASES = [
  { label: 'defaults', env: {}, name: 'HIMS', prefix: 'hims' },
  { label: 'Acme Health', env: { BRAND_NAME: 'Acme Health', BRAND_COOKIE_PREFIX: 'acme' }, name: 'Acme Health', prefix: 'acme' },
] as const

describe.each(CASES)('brand wiring ($label)', ({ env, name, prefix }) => {
  it('names every session cookie from the brand prefix, in every module that writes one', async () => {
    await withBrand(env)
    const auth = await import('@/lib/auth')
    const patient = await import('@/lib/patient-session')
    const pending = await import('@/lib/mfa-pending-session')

    expect(auth.SESSION_COOKIE_NAME).toBe(`${prefix}_session`)
    expect(patient.PATIENT_SESSION_COOKIE_NAME).toBe(`${prefix}_patient_session`)

    await auth.setSessionCookie('admin', 'A', null)
    await patient.setPatientSessionCookie('RD-0001')
    await pending.setPendingStaffMfaCookie({ role: 'admin', name: 'A', mode: 'verify', userId: null, method: 'totp' })
    await pending.setPendingPatientMfaCookie({ patientId: 'RD-0001' })
    await pending.setPendingGoogleOAuthCookie({ state: 's', codeVerifier: 'v', nonce: 'n' })
    await pending.clearPendingStaffMfaCookie()
    await pending.clearPendingPatientMfaCookie()
    await pending.clearPendingGoogleOAuthCookie()
    await patient.clearPatientSessionCookie()

    expect(cookieWrites).toEqual([
      `${prefix}_session`,
      `${prefix}_patient_session`,
      `${prefix}_pending_staff_mfa`,
      `${prefix}_pending_patient_mfa`,
      `${prefix}_pending_google_oauth`,
      `delete:${prefix}_pending_staff_mfa`,
      `delete:${prefix}_pending_patient_mfa`,
      `delete:${prefix}_pending_google_oauth`,
      `delete:${prefix}_patient_session`,
    ])
    expect(cookieWrites.join(' ')).not.toMatch(/clinsync/i)
  })

  it('proxy reads the same session cookie auth.ts writes (and nothing else)', async () => {
    await withBrand(env)
    const { buildSessionCookieValue } = await import('@/lib/auth')
    const { proxy } = await import('@/proxy')
    const token = await buildSessionCookieValue('admin', 'A', null)

    const ok = await proxy(new NextRequest('http://localhost/patients', { headers: { cookie: `${prefix}_session=${token}` } }))
    expect(ok.headers.get('location')).toBeNull()

    for (const wrongName of ['clinsync_demo_session', prefix === 'hims' ? 'acme_session' : 'hims_session']) {
      const res = await proxy(new NextRequest('http://localhost/patients', { headers: { cookie: `${wrongName}=${token}` } }))
      expect(res.headers.get('location')).toBe('http://localhost/login')
    }
  })

  it('uses the brand for the MFA issuer at enrolment (env brand when the settings cannot be read)', async () => {
    await withBrand(env)
    vi.doMock('@/lib/patient-session', () => ({ requirePatientSession: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
    vi.doMock('@/lib/queries/patient-portal', () => ({ getPatientMfaState: vi.fn(async () => null), setPatientMfaSecret: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
    const { POST } = await import('@/app/api/patient-portal/account/mfa/enroll/route')
    const { qrDataUrl } = await (await POST()).json()
    vi.doUnmock('@/lib/patient-session')
    vi.doUnmock('@/lib/queries/patient-portal')
    vi.doUnmock('@/lib/patient-portal-audit')
    const uri = new URL(qrDataUrl.replace(/^qr:/, ''))
    expect(uri.searchParams.get('issuer')).toBe(name)
  })

  it('uses the brand in the OTP email subject', async () => {
    await withBrand(env)
    const { generateAndSendOtp } = await import('@/lib/otp-delivery')
    const { sendEmail } = await import('@/lib/email')
    await generateAndSendOtp('id-1', 'email', 'someone@example.test')
    expect(vi.mocked(sendEmail).mock.calls[0][1]).toBe(`Your ${name} verification code`)
  })

  it('uses the brand in the OTP SMS text', async () => {
    await withBrand(env)
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACunit')
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'unit')
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15550000000')
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const { sendSms } = await import('@/lib/sms')
    await sendSms('+15551234567', '123456')
    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams
    expect(body.get('Body')).toBe(`Your ${name} verification code is 123456. It expires in 5 minutes.`)
  })

  it('uses the brand for the automated system sender name', async () => {
    await withBrand(env)
    const { systemSenderName } = await import('@/lib/queries/eligibility')
    expect(await systemSenderName()).toBe(`${name} (Automated)`)
  })
})
