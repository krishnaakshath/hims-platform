// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import type { Session } from '@/lib/auth'
import type { BrandSettingsInput } from '@/lib/brand-snapshot'
import type { ChannelAdapter, ChannelRegistry, DeliveryChannel } from '@/lib/notify/registry'
import type { NotificationStore } from '@/lib/notify/send'

// WL T10 (groups 4-5): email, SMS and MFA identity read the brand at request time (getBrand).
// Spec D13: plain-text email, the stored signature appended after "-- ", subjects use the display
// name. D14: the SMS `hospitalName` is smsName (falling back to the display name); the DLT sender
// id stays env. D15: the MFA issuer is resolved at enrolment. With no stored row, every message is
// exactly today's (env brand).

type Mail = { from: string; to: string; subject: string; text: string }
const sendMail = vi.hoisted(() => vi.fn<(m: Mail) => Promise<{ messageId: string }>>(async () => ({ messageId: 'm1' })))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }))
vi.mock('@/lib/cache', () => ({ getRedis: () => ({ set: vi.fn(async () => 'OK'), get: vi.fn(async () => null), del: vi.fn(async () => 1) }) }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (uri: string) => `qr:${uri}`) } }))
vi.mock('@/lib/patient-session', () => ({ requirePatientSession: vi.fn(async () => ({ patientId: 'RD-0042' })) }))
vi.mock('@/lib/queries/patient-portal', () => ({ getPatientMfaState: vi.fn(async () => ({ mfaEnabled: false })), setPatientMfaSecret: vi.fn(async () => undefined) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/crypto', () => ({ encryptSensitive: (s: string) => `enc:${s.length}` }))

const BRAND_VARS = ['BRAND_NAME', 'BRAND_LEGAL_NAME', 'BRAND_LOGO_URL']
const SIGNATURE = 'Sunrise Hospital, Pune\nReception: 020 4000 1000'

function fakeAdapter(name: DeliveryChannel) {
  return { name, configured: () => true, send: vi.fn<ChannelAdapter['send']>(async () => ({ ok: true, providerMessageId: `${name}-id` })) }
}
function fakeRegistry() {
  return { sms: fakeAdapter('sms'), email: fakeAdapter('email'), whatsapp: fakeAdapter('whatsapp'), in_app: fakeAdapter('in_app') } satisfies ChannelRegistry
}
const store: NotificationStore = {
  templateConfig: async () => ({ channels: ['sms', 'email'], dltTemplateId: '1107', whatsappTemplateName: null }),
  patientPreferences: async () => ({ optOut: false, sms: true, whatsapp: true, email: true }),
  record: async () => undefined,
}
const DESTINATION = { phone: '98450 13210', email: 'asha.rao@example.com' }

describe.skipIf(!process.env.DATABASE_URL)('messages read the stored brand (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const ACTOR = `TEST-WL-T10-MSG-${RUN}`
  const session: Session = { role: 'admin', name: ACTOR, userId: null }

  const blank = (over: Partial<BrandSettingsInput> = {}): BrandSettingsInput => ({
    displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, ...over,
  })

  beforeEach(() => {
    for (const k of BRAND_VARS) vi.stubEnv(k, '')
    for (const [k, v] of Object.entries({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'noreply@example.test' })) vi.stubEnv(k, v)
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACunit')
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'unit')
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15550000000')
    sendMail.mockClear()
    vi.resetModules()
  })

  afterEach(async () => {
    const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
    await resetBrandSettings(null)
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { auditLog } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  async function storeSunrise() {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const r = await q.updateBrandSettings(blank({ displayName: 'Sunrise', emailSignature: SIGNATURE, smsName: 'SUNRISE HSP' }), 0, session)
    expect(r.ok).toBe(true)
  }

  async function reset() {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const { getBrand } = await import('@/lib/brand-server')
    return getBrand()
  }

  it('OTP email: subject uses the stored name and the body ends with the stored signature', async () => {
    await storeSunrise()
    const { generateAndSendOtp } = await import('@/lib/otp-delivery')
    await generateAndSendOtp('id-1', 'email', 'asha.rao@example.com')
    const mail = sendMail.mock.calls[0][0]
    expect(mail.subject).toBe('Your Sunrise verification code')
    expect(mail.text).toMatch(/^Your verification code is \d{6}\. It expires in 5 minutes\.\n\n-- \n/)
    expect(mail.text.endsWith(`\n\n-- \n${SIGNATURE}`)).toBe(true)
  })

  it('OTP email with no stored brand: env name in the subject, no signature', async () => {
    const b = await reset()
    const { generateAndSendOtp } = await import('@/lib/otp-delivery')
    await generateAndSendOtp('id-1', 'email', 'asha.rao@example.com')
    const mail = sendMail.mock.calls[0][0]
    expect(mail.subject).toBe(`Your ${b.name} verification code`)
    expect(mail.text).toMatch(/^Your verification code is \d{6}\. It expires in 5 minutes\.$/)
  })

  it('OTP SMS names the stored SMS name; with no stored brand, the env name', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const bodyOf = (i: number) => ((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body as URLSearchParams).get('Body')

    await storeSunrise()
    let { sendSms } = await import('@/lib/sms')
    await sendSms('+919845013210', '123456')
    expect(bodyOf(0)).toBe('Your SUNRISE HSP verification code is 123456. It expires in 5 minutes.')

    const b = await reset()
    vi.resetModules()
    ;({ sendSms } = await import('@/lib/sms'))
    await sendSms('+919845013210', '123456')
    expect(bodyOf(1)).toBe(`Your ${b.name} verification code is 123456. It expires in 5 minutes.`)
  })

  it('booking_confirmed: SMS text renders smsName; the email gets the display-name subject and the signature', async () => {
    await storeSunrise()
    const { getBrand } = await import('@/lib/brand-server')
    const { sendNotification } = await import('@/lib/notify/send')
    const registry = fakeRegistry()
    await sendNotification({
      patientId: 'RD-0042', templateKey: 'booking_confirmed', destination: DESTINATION,
      vars: { hospitalName: (await getBrand()).smsName, visitDate: '2026-10-24', timeLabel: '10:30 AM' },
    }, { registry, store })
    const sms = registry.sms.send.mock.calls[0][0]
    const email = registry.email.send.mock.calls[0][0]
    expect(sms.text).toBe('SUNRISE HSP: Your appointment is confirmed for 24 Oct 2026, 10:30 AM. Sign in to the patient portal for details.')
    expect(sms.params[0]).toBe('SUNRISE HSP')
    expect(email.subject).toBe('Sunrise: Appointment confirmed')
    expect(email.text).toBe(`${sms.text}\n\n-- \n${SIGNATURE}`)
  })

  it('a notice with no hospitalName var defaults it to the stored SMS name', async () => {
    await storeSunrise()
    const { sendNotification } = await import('@/lib/notify/send')
    const registry = fakeRegistry()
    const r = await sendNotification({ patientId: 'RD-0042', templateKey: 'form_sent', destination: DESTINATION, vars: {} }, { registry, store })
    expect(r.attempts.map((a) => a.status)).toEqual(['sent', 'sent'])
    expect(registry.sms.send.mock.calls[0][0].text).toMatch(/^SUNRISE HSP: You have a form to fill in\./)
  })

  it('booking_confirmed with no stored brand: env name everywhere, no signature', async () => {
    const b = await reset()
    const { sendNotification } = await import('@/lib/notify/send')
    const registry = fakeRegistry()
    await sendNotification({
      patientId: 'RD-0042', templateKey: 'booking_confirmed', destination: DESTINATION,
      vars: { hospitalName: b.smsName, visitDate: '2026-10-24', timeLabel: '10:30 AM' },
    }, { registry, store })
    expect(b.smsName).toBe(b.name)
    const sms = registry.sms.send.mock.calls[0][0]
    const email = registry.email.send.mock.calls[0][0]
    expect(sms.text.startsWith(`${b.name}: Your appointment is confirmed`)).toBe(true)
    expect(email.subject).toBe(`${b.name}: Appointment confirmed`)
    expect(email.text).toBe(sms.text)
  })

  it('MFA enrolment: the otpauth URI carries the stored name as issuer; with no stored brand, the env issuer', async () => {
    await storeSunrise()
    let { POST } = await import('@/app/api/patient-portal/account/mfa/enroll/route')
    let body = await (await POST()).json()
    expect(new URL(body.qrDataUrl.replace(/^qr:/, '')).searchParams.get('issuer')).toBe('Sunrise')

    const b = await reset()
    vi.resetModules()
    ;({ POST } = await import('@/app/api/patient-portal/account/mfa/enroll/route'))
    body = await (await POST()).json()
    expect(new URL(body.qrDataUrl.replace(/^qr:/, '')).searchParams.get('issuer')).toBe(b.mfaIssuer)
  })

  it('the automated system sender name follows the stored name', async () => {
    await storeSunrise()
    const { systemSenderName } = await import('@/lib/queries/eligibility')
    expect(await systemSenderName()).toBe('Sunrise (Automated)')
    const b = await reset()
    expect(await systemSenderName()).toBe(b.systemSenderName)
  })
})
