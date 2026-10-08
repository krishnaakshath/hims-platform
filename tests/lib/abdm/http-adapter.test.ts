import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { httpAbdmGateway } from '@/lib/abdm/http-adapter'
import { ABDM_PATHS, ABHA_ENCRYPTION_ALGORITHM, ENROL_CONSENT } from '@/lib/abdm/constants'
import { resetGatewayTokenCache } from '@/lib/abdm/session'
import type { AbdmConfig } from '@/lib/integrations/config'

const CFG: AbdmConfig = {
  gatewayBaseUrl: 'https://gw.example', abhaBaseUrl: 'https://abhasbx.example', clientId: 'cid', clientSecret: 'csec', cmId: 'sbx',
  hipId: null, gatewayJwksUrl: null, consentTextPath: null,
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: AbortSignal | null | undefined }

function adapter(routes: Record<string, Response | (() => Promise<Response>)>) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/^https:\/\/[^/]+/, '')
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal })
    if (path === ABDM_PATHS.session) return json(202, { accessToken: 'GW', expiresIn: 1200 })
    const r = routes[path]
    if (!r) return json(404, {})
    return typeof r === 'function' ? r() : r.clone()
  })
  const gw = httpAbdmGateway(CFG, { fetch, now: () => new Date('2026-10-08T00:00:00Z') })
  return { gw, calls, fetch }
}

const S1_PROFILE = {
  firstName: 'Asha', middleName: '', lastName: 'Rao', dob: '12-03-1990', gender: 'F', mobile: '9876500903', email: null,
  phrAddress: ['asha.rao@sbx'], ABHANumber: '91-1234-5678-9012', abhaStatus: 'ACTIVE', abhaType: 'STANDARD',
}

beforeEach(() => resetGatewayTokenCache())
let info: ReturnType<typeof vi.spyOn>
beforeEach(() => { info = vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('httpAbdmGateway', () => {
  it('requests an Aadhaar enrolment OTP with the documented body', async () => {
    const { gw, calls } = adapter({ [ABDM_PATHS.enrolRequestOtp]: json(200, { txnId: 't1', message: 'sent' }) })
    expect(await gw.enrolRequestAadhaarOtp({ encryptedAadhaar: 'ENC' })).toEqual({ ok: true, value: { txnId: 't1' } })
    expect(calls.at(-1)!.url).toBe('https://abhasbx.example' + ABDM_PATHS.enrolRequestOtp)
    expect(calls.at(-1)!.method).toBe('POST')
    expect(calls.at(-1)!.body).toEqual({ txnId: '', scope: ['abha-enrol'], loginHint: 'aadhaar', loginId: 'ENC', otpSystem: 'aadhaar' })
    expect(calls.at(-1)!.headers).toMatchObject({ Authorization: 'Bearer GW', 'REQUEST-ID': expect.stringMatching(UUID), TIMESTAMP: expect.any(String) })
    expect(calls.at(-1)!.signal).toBeInstanceOf(AbortSignal)
  })
  it('enrols with consent abha-enrollment 1.4 and maps the profile', async () => {
    const { gw, calls } = adapter({ [ABDM_PATHS.enrolByAadhaar]: json(200, { message: 'ok', txnId: 't2', tokens: { token: 'UT', expiresIn: 1800 }, ABHAProfile: S1_PROFILE, isNew: true }) })
    const r = await gw.enrolByAadhaarOtp({ txnId: 't1', encryptedOtp: 'EOTP', mobile: '9876500903' })
    expect(calls.at(-1)!.body).toEqual({ authData: { authMethods: ['otp'], otp: { txnId: 't1', otpValue: 'EOTP', mobile: '9876500903' } }, consent: { code: 'abha-enrollment', version: '1.4' } })
    expect(ENROL_CONSENT).toEqual({ code: 'abha-enrollment', version: '1.4' })
    expect(r).toEqual({
      ok: true,
      value: {
        txnId: 't2', userToken: 'UT', isNew: true,
        profile: { abhaNumber: '91123456789012', abhaAddresses: ['asha.rao@sbx'], preferredAbhaAddress: 'asha.rao@sbx', name: 'Asha Rao', gender: 'F', yearOfBirth: 1990, mobileMasked: '******0903', abhaStatus: 'ACTIVE' },
      },
    })
  })
  it('reads address suggestions with the transaction header and sets the preferred address', async () => {
    const { gw, calls } = adapter({
      [ABDM_PATHS.enrolSuggestion]: json(200, { txnId: 't2', abhaAddressList: ['asha.rao', 'asharao90'] }),
      [ABDM_PATHS.enrolAbhaAddress]: json(200, { txnId: 't2', healthIdNumber: '91-1234-5678-9012', preferredAbhaAddress: 'asha.rao@sbx' }),
    })
    expect(await gw.enrolAddressSuggestions({ txnId: 't2' })).toEqual({ ok: true, value: { suggestions: ['asha.rao', 'asharao90'] } })
    expect(calls.at(-1)!.method).toBe('GET'); expect(calls.at(-1)!.headers.TRANSACTION_ID).toBe('t2')
    expect(await gw.enrolSetAddress({ txnId: 't2', abhaAddress: 'asha.rao' })).toEqual({ ok: true, value: { preferredAbhaAddress: 'asha.rao@sbx' } })
    expect(calls.at(-1)!.body).toEqual({ txnId: 't2', abhaAddress: 'asha.rao', preferred: 1 })
  })
  it('login OTP requests use the route scope, hint and OTP system; the address route uses the PHR path', async () => {
    const { gw, calls } = adapter({ [ABDM_PATHS.loginRequestOtp]: json(200, { txnId: 'L1' }), [ABDM_PATHS.phrRequestOtp]: json(200, { txnId: 'L2' }) })
    expect(await gw.loginRequestOtp({ route: 'abha_number_aadhaar_otp', encryptedLoginId: 'EID' })).toEqual({ ok: true, value: { txnId: 'L1' } })
    expect(calls.at(-1)!.body).toEqual({ scope: ['abha-login', 'aadhaar-verify'], loginHint: 'abha-number', loginId: 'EID', otpSystem: 'aadhaar' })
    expect(await gw.loginRequestOtp({ route: 'abha_address_otp', encryptedLoginId: 'EADDR' })).toEqual({ ok: true, value: { txnId: 'L2' } })
    expect(calls.at(-1)!.url).toBe('https://abhasbx.example' + ABDM_PATHS.phrRequestOtp)
    expect(calls.at(-1)!.body).toEqual({ scope: ['abha-address-login', 'mobile-verify'], loginHint: 'abha-address', loginId: 'EADDR', otpSystem: 'abdm' })
  })
  it('mobile login returns a transient token and needs an account choice', async () => {
    const { gw, calls } = adapter({
      [ABDM_PATHS.loginVerify]: json(200, { txnId: 'L1', authResult: 'success', token: 'T300', expiresIn: 300, accounts: [{ ABHANumber: '91-1111-2222-3333', name: 'Asha Rao' }, { ABHANumber: '91-1111-2222-4444' }] }),
      [ABDM_PATHS.loginVerifyUser]: json(200, { token: 'UT2', expiresIn: 1800 }),
    })
    const r = await gw.loginVerifyOtp({ route: 'mobile_otp', txnId: 'L1', encryptedOtp: 'EOTP' })
    expect(r).toEqual({ ok: true, value: { userToken: null, transientToken: 'T300', accounts: [{ abhaNumber: '91111122223333', name: 'Asha Rao' }, { abhaNumber: '91111122224444', name: null }] } })
    expect(calls.at(-1)!.body).toEqual({ scope: ['abha-login', 'mobile-verify'], authData: { authMethods: ['otp'], otp: { txnId: 'L1', otpValue: 'EOTP' } } })
    expect(await gw.loginSelectAccount({ transientToken: 'T300', txnId: 'L1', abhaNumber: '91111122223333' })).toEqual({ ok: true, value: { userToken: 'UT2' } })
    expect(calls.at(-1)!.headers['T-token']).toBe('Bearer T300')
    expect(calls.at(-1)!.body).toEqual({ ABHANumber: '91-1111-2222-3333', txnId: 'L1' })
  })
  it('an ABHA-number Aadhaar OTP login returns the final user token', async () => {
    const { gw } = adapter({ [ABDM_PATHS.loginVerify]: json(200, { token: 'UT3', accounts: [{ ABHANumber: '91-1111-2222-3333' }] }) })
    expect(await gw.loginVerifyOtp({ route: 'abha_number_aadhaar_otp', txnId: 'L1', encryptedOtp: 'E' })).toMatchObject({ ok: true, value: { userToken: 'UT3', transientToken: null } })
  })
  it('profile fetch sends X-token with the Bearer prefix', async () => {
    const { gw, calls } = adapter({
      [ABDM_PATHS.profileAccount]: json(200, { ...S1_PROFILE, ABHANumber: '91-1234-5678-9012', preferredAbhaAddress: 'asha.rao@sbx', name: 'Asha Rao', yearOfBirth: '1990' }),
      [ABDM_PATHS.phrProfile]: json(200, { abhaAddress: 'asha.rao@sbx', fullName: 'Asha Rao', abhaNumber: '91-1234-5678-9012', gender: 'F', dateOfBirth: '1990-03-12', mobile: 'XXXXXX0903' }),
    })
    const r = await gw.fetchProfile({ userToken: 'UT', route: 'abha_number_mobile_otp' })
    expect(calls.at(-1)!.headers['X-token']).toBe('Bearer UT'); expect(calls.at(-1)!.method).toBe('GET')
    expect(r).toMatchObject({ ok: true, value: { abhaNumber: '91123456789012', name: 'Asha Rao', yearOfBirth: 1990, preferredAbhaAddress: 'asha.rao@sbx', mobileMasked: '******0903' } })
    const p = await gw.fetchProfile({ userToken: 'UT', route: 'abha_address_otp' })
    expect(calls.at(-1)!.url).toBe('https://abhasbx.example' + ABDM_PATHS.phrProfile)
    expect(p).toMatchObject({ ok: true, value: { abhaNumber: '91123456789012', abhaAddresses: ['asha.rao@sbx'], name: 'Asha Rao', gender: 'F', yearOfBirth: 1990 } })
  })
  it('a profile without a valid ABHA number is unavailable, not guessed', async () => {
    const { gw } = adapter({ [ABDM_PATHS.profileAccount]: json(200, { name: 'X' }) })
    expect(await gw.fetchProfile({ userToken: 'UT', route: 'mobile_otp' })).toEqual({ ok: false, error: 'abdm_unavailable' })
  })
  it('a 401 on OTP verify is otp_invalid and the body never surfaces', async () => {
    const { gw } = adapter({ [ABDM_PATHS.loginVerify]: json(401, { message: 'otp 654321 invalid for 234123412346' }) })
    const r = await gw.loginVerifyOtp({ route: 'abha_number_aadhaar_otp', txnId: 't', encryptedOtp: 'E' })
    expect(r).toEqual({ ok: false, error: 'otp_invalid' }); expect(JSON.stringify(r)).not.toMatch(/654321|234123412346/)
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/654321|234123412346/)
  })
  it('a 400 is invalid_input and a 429 is rate_limited', async () => {
    const { gw } = adapter({ [ABDM_PATHS.enrolRequestOtp]: json(400, { message: 'bad 234123412346' }), [ABDM_PATHS.loginRequestOtp]: json(429, {}) })
    expect(await gw.enrolRequestAadhaarOtp({ encryptedAadhaar: 'E' })).toEqual({ ok: false, error: 'invalid_input' })
    expect(await gw.loginRequestOtp({ route: 'mobile_otp', encryptedLoginId: 'E' })).toEqual({ ok: false, error: 'rate_limited' })
  })
  it('times out after 15 s as abdm_unavailable', async () => {
    vi.useFakeTimers()
    try {
      const hang = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
      const calls: (AbortSignal | undefined)[] = []
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith(ABDM_PATHS.session)) return json(202, { accessToken: 'GW', expiresIn: 1200 })
        calls.push(init?.signal ?? undefined)
        return hang(init!.signal!)
      })
      const gw = httpAbdmGateway(CFG, { fetch, now: () => new Date() })
      const p = gw.loginRequestOtp({ route: 'mobile_otp', encryptedLoginId: 'E' })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(calls[0]!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(await p).toEqual({ ok: false, error: 'abdm_unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('a gateway token failure maps to abdm_unavailable', async () => {
    const fetch = vi.fn(async () => json(500, {}))
    const gw = httpAbdmGateway(CFG, { fetch, now: () => new Date() })
    expect(await gw.enrolRequestAadhaarOtp({ encryptedAadhaar: 'E' })).toEqual({ ok: false, error: 'abdm_unavailable' })
  })
  it('logs only the action, status and duration', async () => {
    const { gw } = adapter({ [ABDM_PATHS.enrolRequestOtp]: json(200, { txnId: 'secret-txn' }) })
    await gw.enrolRequestAadhaarOtp({ encryptedAadhaar: 'ENC-VALUE' })
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).toContain('enrol_request_otp'); expect(logged).toContain('httpStatus')
    expect(logged).not.toMatch(/secret-txn|ENC-VALUE|GW/)
  })
  it('encrypts with the ABHA public key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const { gw } = adapter({ [ABDM_PATHS.publicCert]: json(200, { publicKey: spki, encryptionAlgorithm: ABHA_ENCRYPTION_ALGORITHM }) })
    const r = await gw.encrypt('123456')
    if (!r.ok) throw new Error('expected ok')
    expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(r.value, 'base64')).toString()).toBe('123456')
  })
  it('a bad public key is abdm_unavailable without the plaintext', async () => {
    const { gw } = adapter({ [ABDM_PATHS.publicCert]: json(200, { publicKey: 'junk', encryptionAlgorithm: ABHA_ENCRYPTION_ALGORITHM }) })
    const r = await gw.encrypt('234123412346')
    expect(r).toEqual({ ok: false, error: 'abdm_unavailable' })
  })
  it('test connection fetches a fresh token and reports its life', async () => {
    const { gw, calls } = adapter({})
    expect(await gw.testConnection()).toEqual({ ok: true, value: { tokenExpiresInSeconds: 1200 } })
    expect(calls.filter((c) => c.url.endsWith(ABDM_PATHS.session))).toHaveLength(1)
    expect(gw.status()).toEqual({ state: 'configured', label: 'Connected' })
    expect(gw.source).toBe('abdm')
  })
})
