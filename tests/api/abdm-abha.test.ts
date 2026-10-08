import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import type { AbhaFlow } from '@/lib/abdm/flow-store'
import type { AbdmGateway } from '@/lib/abdm/gateway'

let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Desk One', userId: null })) }
})
const logAudit = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined)
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }))

let rateAllowed = true
const rateCalls: string[] = []
vi.mock('@/lib/rate-limit', () => ({ checkAbhaRateLimit: vi.fn(async (name: string) => { rateCalls.push(name); return { allowed: rateAllowed } }) }))

const flows = new Map<string, AbhaFlow>()
const saveFlow = vi.fn(async (f: AbhaFlow) => { flows.set(f.flowId, structuredClone(f)) })
vi.mock('@/lib/abdm/flow-store', () => ({
  createFlow: vi.fn(async (init: Pick<AbhaFlow, 'staffName' | 'staffUserId' | 'patientId' | 'kind'>) => {
    const f: AbhaFlow = { flowId: '11111111-1111-4111-8111-111111111111', txnId: null, userToken: null, transientToken: null, consentId: null, consentPurpose: null, verified: null, accounts: [], ...init }
    flows.set(f.flowId, f)
    return f
  }),
  getFlow: vi.fn(async (id: string, staff: string) => { const f = flows.get(id); return f && f.staffName === staff ? structuredClone(f) : null }),
  saveFlow: (f: AbhaFlow) => saveFlow(f),
  deleteFlow: vi.fn(async (id: string) => { flows.delete(id) }),
}))

const recordConsent = vi.fn<(...args: unknown[]) => Promise<{ consentId: number }>>(async () => ({ consentId: 42 }))
const applyVerifiedAbha = vi.fn<(...args: unknown[]) => Promise<{ ok: true } | { ok: false; error: 'not_found' | 'abha_conflict' | 'flow_not_verified' }>>(async () => ({ ok: true }))
vi.mock('@/lib/queries/abha-link', () => ({ recordConsent: (...a: unknown[]) => recordConsent(...a), applyVerifiedAbha: (...a: unknown[]) => applyVerifiedAbha(...a) }))
vi.mock('@/lib/cache', () => ({ invalidateCache: vi.fn(async () => undefined), patientDetailCacheKey: (id: string) => `p:${id}` }))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const PROFILE = { abhaNumber: '91123456789012', abhaAddresses: ['asha.rao@sbx'], preferredAbhaAddress: 'asha.rao@sbx', name: 'Asha Rao', gender: 'F' as const, yearOfBirth: 1990, mobileMasked: '******0903', abhaStatus: 'ACTIVE' }
function makeGateway(): { [K in keyof AbdmGateway]: AbdmGateway[K] extends (...a: infer A) => infer R ? ReturnType<typeof vi.fn<(...a: A) => R>> : AbdmGateway[K] } {
  return {
    source: 'abdm',
    status: vi.fn(() => ({ state: 'configured' as const, label: 'Connected' })),
    testConnection: vi.fn(async () => ok({ tokenExpiresInSeconds: 1200 })),
    encrypt: vi.fn(async (p: string) => ok(`ENC(${p.length})`)),
    enrolRequestAadhaarOtp: vi.fn(async () => ok({ txnId: 'T1' })),
    enrolByAadhaarOtp: vi.fn(async () => ok({ txnId: 'T2', userToken: 'USERTOKEN-SECRET', profile: PROFILE, isNew: true })),
    enrolAddressSuggestions: vi.fn(async () => ok({ suggestions: ['asha.rao'] })),
    enrolSetAddress: vi.fn(async () => ok({ preferredAbhaAddress: 'asha.rao@sbx' })),
    loginRequestOtp: vi.fn(async () => ok({ txnId: 'L1' })),
    loginVerifyOtp: vi.fn(async () => ok({ userToken: 'USERTOKEN-SECRET', transientToken: null, accounts: [] as { abhaNumber: string; name: string | null }[] })),
    loginSelectAccount: vi.fn(async () => ok({ userToken: 'USERTOKEN-2' })),
    fetchProfile: vi.fn(async () => ok(PROFILE)),
  } as never
}
let gw = makeGateway()
let gatewayOn = true
vi.mock('@/lib/abdm/registry', () => ({ getAbdmGateway: vi.fn(() => (gatewayOn ? gw : null)) }))

import { POST as consentPost, GET as consentGet } from '@/app/api/abdm/abha/consent/route'
import { POST as enrolOtp } from '@/app/api/abdm/abha/enrol/otp/route'
import { POST as enrolVerify } from '@/app/api/abdm/abha/enrol/verify/route'
import { POST as addressPost, GET as addressGet } from '@/app/api/abdm/abha/enrol/address/route'
import { POST as loginOtp } from '@/app/api/abdm/abha/login/otp/route'
import { POST as loginVerify } from '@/app/api/abdm/abha/login/verify/route'
import { POST as loginAccount } from '@/app/api/abdm/abha/login/account/route'
import { POST as linkPost } from '@/app/api/patients/[anonId]/abha/link/route'
import { MOCK_CONSENT_TEXT, sha256Hex, VERIFICATION_CONSENT_TEXT } from '@/lib/abdm/consent'

const F = '11111111-1111-4111-8111-111111111111'
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ROUTES: Record<string, (r: NextRequest) => Promise<Response>> = {
  consent: consentPost, 'enrol/otp': enrolOtp, 'enrol/verify': enrolVerify, 'enrol/address': addressPost, 'login/otp': loginOtp, 'login/verify': loginVerify, 'login/account': loginAccount,
}
const post = (name: string, body: unknown) => ROUTES[name](req(`/api/abdm/abha/${name}`, body))
const link = (body: unknown, anonId = 'RD-1') => linkPost(req(`/api/patients/${anonId}/abha/link`, body), { params: Promise.resolve({ anonId }) })

function seedFlow(over: Partial<AbhaFlow> = {}) {
  flows.set(F, { flowId: F, staffName: 'Desk One', staffUserId: null, patientId: null, kind: 'enrolment', txnId: null, userToken: null, transientToken: null, consentId: 42, consentPurpose: 'abha_enrolment', verified: null, accounts: [], ...over })
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = []
beforeEach(() => {
  sessionRole = 'frontdesk'; rateAllowed = true; rateCalls.length = 0; gatewayOn = true; gw = makeGateway(); flows.clear()
  vi.clearAllMocks()
  consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => { for (const s of consoleSpies) s.mockRestore() })
const consoleText = () => JSON.stringify(consoleSpies.map((s) => s.mock.calls))

describe('ABHA routes: gate, rate limit, configuration', () => {
  it('billing, pharmacy, labs, coder, rcm get 403 before the body is read', async () => {
    for (const role of ['billing', 'pharmacy', 'labs', 'coder', 'rcm', 'pi', 'collector'] as Role[]) {
      sessionRole = role
      for (const name of Object.keys(ROUTES)) {
        const r = await post(name, '{not json')
        expect(r.status, `${name} ${role}`).toBe(403)
        expect(await r.json()).toEqual({ error: 'Forbidden' })
      }
      expect((await link('{not json')).status).toBe(403)
    }
    expect(rateCalls).toEqual([])
  })
  it('admin, frontdesk and crc pass the gate', async () => {
    for (const role of ['admin', 'frontdesk', 'crc'] as Role[]) {
      sessionRole = role
      expect((await post('enrol/otp', '{not json')).status).toBe(400)
    }
  })
  it('503 when ABDM is not configured', async () => {
    gatewayOn = false
    const r = await post('enrol/otp', { flowId: F, aadhaar: '2341 2341 2346' })
    expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: 'ABDM is not configured' })
    expect((await consentGet()).status).toBe(503)
  })
  it('a 429 after 10 attempts per minute', async () => {
    rateAllowed = false
    const r = await post('login/otp', { route: 'mobile_otp', loginId: '9876500903' })
    expect(r.status).toBe(429); expect(await r.json()).toEqual({ error: 'Too many attempts; wait a minute and try again' })
    expect(gw.loginRequestOtp).not.toHaveBeenCalled()
  })
})

describe('consent', () => {
  it('GET returns the state and the exact texts', async () => {
    const r = await consentGet()
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.state).toBe('configured'); expect(b.verification).toEqual({ text: VERIFICATION_CONSENT_TEXT, sha256: sha256Hex(VERIFICATION_CONSENT_TEXT) })
  })
  it('enrolment needs consent first, and the installed consent text', async () => {
    seedFlow({ consentId: null, consentPurpose: null })
    const r = await post('enrol/otp', { flowId: F, aadhaar: '2341 2341 2346' })
    expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'Record the patient\'s consent first' })
    // Real gateway, no NHA text installed: 409.
    const c = await post('consent', { purpose: 'abha_enrolment', givenBy: 'patient', textSha256: 'a'.repeat(64) })
    expect(c.status).toBe(409)
    expect(await c.json()).toEqual({ error: 'ABHA creation is not available until the NHA consent text is installed (see docs/ABDM-NHCX.md)' })
  })
  it('the mock records consent against its fixed text; a wrong hash is refused', async () => {
    gw = { ...makeGateway(), source: 'abdm_sandbox_mock' } as never
    expect((await post('consent', { purpose: 'abha_enrolment', givenBy: 'patient', textSha256: 'b'.repeat(64) })).status).toBe(400)
    const r = await post('consent', { purpose: 'abha_enrolment', givenBy: 'guardian', textSha256: sha256Hex(MOCK_CONSENT_TEXT) })
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ flowId: F, consentId: 42 })
    expect(flows.get(F)).toMatchObject({ consentId: 42, consentPurpose: 'abha_enrolment', kind: 'enrolment' })
    expect(recordConsent).toHaveBeenCalledWith({ flowId: F, patientId: null, purpose: 'abha_enrolment', givenBy: 'guardian', textSha256: sha256Hex(MOCK_CONSENT_TEXT) }, expect.objectContaining({ name: 'Desk One' }))
  })
})

describe('enrolment', () => {
  it('an Aadhaar OTP request leaves no trace in the flow store, the audit row or the response', async () => {
    seedFlow()
    const res = await post('enrol/otp', { flowId: F, aadhaar: '2341 2341 2346' })
    expect(res.status).toBe(200)
    const everything = JSON.stringify([await res.json(), saveFlow.mock.calls, [...flows.values()], logAudit.mock.calls, consoleText(), gw.enrolRequestAadhaarOtp.mock.calls])
    expect(everything).not.toMatch(/234123412346|2341 2341 2346/)
    expect(gw.encrypt).toHaveBeenCalledWith('2341 2341 2346'.replace(/\s/g, ''))
    expect(gw.enrolRequestAadhaarOtp).toHaveBeenCalledWith({ encryptedAadhaar: 'ENC(12)' })
    expect(flows.get(F)!.txnId).toBe('T1')
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'abdm: requested ABHA enrolment OTP', null, 'flow=11111111 step=enrol_otp')
  })
  it('a malformed Aadhaar is refused without echoing it', async () => {
    seedFlow()
    const r = await post('enrol/otp', { flowId: F, aadhaar: '1234 5678 9012' })
    expect(r.status).toBe(400)
    const text = await r.text()
    expect(text).not.toContain('1234'); expect(text).toContain('Enter a valid 12-digit Aadhaar number')
    expect(gw.encrypt).not.toHaveBeenCalled()
  })
  it('the OTP never appears in responses or logs', async () => {
    seedFlow({ txnId: 'T1' })
    const r = await post('enrol/verify', { flowId: F, otp: '654321', mobile: '9876500903' })
    expect(r.status).toBe(200)
    const everything = JSON.stringify([await r.json(), saveFlow.mock.calls, logAudit.mock.calls, consoleText(), gw.enrolByAadhaarOtp.mock.calls])
    expect(everything).not.toContain('654321')
    expect(gw.encrypt).toHaveBeenCalledWith('654321')
  })
  it('responses carry no token or txnId', async () => {
    seedFlow({ txnId: 'T1' })
    const r = await post('enrol/verify', { flowId: F, otp: '123456', mobile: '9876500903' })
    const body = await r.json()
    expect(JSON.stringify(body)).not.toMatch(/userToken|txnId|USERTOKEN|"T1"|"T2"/)
    expect(body).toEqual({ flowId: F, step: 'verified', profile: { name: 'Asha Rao', gender: 'F', yearOfBirth: 1990, abhaNumber: '91-1234-5678-9012', abhaAddress: 'asha.rao@sbx' }, suggestions: ['asha.rao'] })
    expect(flows.get(F)).toMatchObject({ userToken: 'USERTOKEN-SECRET', verified: { abhaNumber: '91123456789012', via: 'aadhaar_otp_enrolment', source: 'abdm' } })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'abdm: created ABHA', null, 'flow=11111111 step=enrol_verify new=true')
  })
  it('a wrong OTP is a fixed 400', async () => {
    seedFlow({ txnId: 'T1' })
    gw.enrolByAadhaarOtp.mockResolvedValueOnce({ ok: false, error: 'otp_invalid' })
    const r = await post('enrol/verify', { flowId: F, otp: '111111', mobile: '9876500903' })
    expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'The OTP is incorrect or has expired' })
  })
  it('an expired or foreign flow is 410', async () => {
    seedFlow({ staffName: 'Someone Else' })
    expect((await post('enrol/otp', { flowId: F, aadhaar: '2341 2341 2346' })).status).toBe(410)
  })
  it('the address step sets the preferred address', async () => {
    seedFlow({ txnId: 'T2', verified: { abhaNumber: '91123456789012', abhaAddress: null, via: 'aadhaar_otp_enrolment', source: 'abdm' } })
    const g = await addressGet(new NextRequest(`http://localhost/api/abdm/abha/enrol/address?flowId=${F}`))
    expect(await g.json()).toEqual({ flowId: F, suggestions: ['asha.rao'] })
    const r = await post('enrol/address', { flowId: F, abhaAddress: 'asha.rao' })
    expect(await r.json()).toEqual({ flowId: F, step: 'address_set', abhaAddress: 'asha.rao@sbx' })
    expect(flows.get(F)!.verified!.abhaAddress).toBe('asha.rao@sbx')
  })
})

describe('login', () => {
  it('an Aadhaar-OTP login needs a verification consent', async () => {
    const r = await post('login/otp', { route: 'aadhaar_otp_login', loginId: '2341 2341 2346' })
    expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'Record the patient\'s consent first' })
    expect(gw.encrypt).not.toHaveBeenCalled()
    seedFlow({ kind: null, consentPurpose: 'abha_verification' })
    const ok2 = await post('login/otp', { flowId: F, route: 'aadhaar_otp_login', loginId: '2341 2341 2346' })
    expect(ok2.status).toBe(200)
    expect(JSON.stringify([saveFlow.mock.calls, logAudit.mock.calls, consoleText()])).not.toMatch(/234123412346/)
  })
  it('an ABHA number is encrypted in its dashed form', async () => {
    await post('login/otp', { route: 'abha_number_mobile_otp', loginId: '91123456789012' })
    expect(gw.encrypt).toHaveBeenCalledWith('91-1234-5678-9012')
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'abdm: requested ABHA login OTP', null, 'flow=11111111 route=abha_number_mobile_otp')
  })
  it('an invalid login id is refused without echo', async () => {
    const r = await post('login/otp', { route: 'mobile_otp', loginId: '12345' })
    expect(r.status).toBe(400); expect(await r.text()).not.toContain('12345')
  })
  it('mobile login asks for an account and masks the choices', async () => {
    seedFlow({ kind: 'mobile_otp', txnId: 'L1', consentId: null, consentPurpose: null })
    gw.loginVerifyOtp.mockResolvedValueOnce(ok({ userToken: null, transientToken: 'T300', accounts: [{ abhaNumber: '91111122223333', name: 'Asha Rao' }, { abhaNumber: '91111122224444', name: null }] }))
    const r = await post('login/verify', { flowId: F, otp: '123456' })
    const body = await r.json()
    expect(body).toEqual({ flowId: F, step: 'choose_account', accounts: [{ abhaNumber: 'XX-XXXX-XXXX-3333', name: 'Asha Rao' }, { abhaNumber: 'XX-XXXX-XXXX-4444', name: null }] })
    expect(JSON.stringify(body)).not.toMatch(/T300|91111122223333/)
    const a = await post('login/account', { flowId: F, accountIndex: 1 })
    expect(a.status).toBe(200)
    expect(gw.loginSelectAccount).toHaveBeenCalledWith({ transientToken: 'T300', txnId: 'L1', abhaNumber: '91111122224444' })
    expect(flows.get(F)).toMatchObject({ transientToken: null, verified: { via: 'mobile_otp' } })
    expect((await post('login/account', { flowId: F, accountIndex: 5 })).status).toBe(410)
  })
  it('a non-mobile login returns the verified profile', async () => {
    seedFlow({ kind: 'abha_number_aadhaar_otp', txnId: 'L1', consentPurpose: 'abha_verification' })
    const r = await post('login/verify', { flowId: F, otp: '123456' })
    expect(await r.json()).toMatchObject({ step: 'verified', profile: { abhaNumber: '91-1234-5678-9012' } })
    expect(flows.get(F)!.verified).toEqual({ abhaNumber: '91123456789012', abhaAddress: 'asha.rao@sbx', via: 'abha_number_aadhaar_otp', source: 'abdm' })
  })
})

describe('link', () => {
  it('links a verified flow and clears it; conflicts and unknown patients are mapped', async () => {
    seedFlow({ verified: { abhaNumber: '91123456789012', abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })
    expect(await (await link({ flowId: F })).json()).toEqual({ ok: true })
    expect(flows.has(F)).toBe(false)
    seedFlow({ verified: { abhaNumber: '91123456789012', abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })
    applyVerifiedAbha.mockResolvedValueOnce({ ok: false, error: 'abha_conflict' })
    const c = await link({ flowId: F })
    expect(c.status).toBe(409); expect(await c.json()).toEqual({ error: 'This ABHA is already linked to another patient' })
    applyVerifiedAbha.mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await link({ flowId: F })).status).toBe(404)
  })
  it('an unverified flow is 410 and a flow for another patient is refused', async () => {
    seedFlow()
    expect((await link({ flowId: F })).status).toBe(410)
    seedFlow({ patientId: 'RD-2', verified: { abhaNumber: '91123456789012', abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })
    expect((await link({ flowId: F }, 'RD-1')).status).toBe(400)
    expect(applyVerifiedAbha).not.toHaveBeenCalled()
  })
})
