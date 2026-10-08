import { describe, it, expect } from 'vitest'
import { mockAbdmGateway } from '@/lib/abdm/mock-adapter'
import { isValidAbhaAddress, isValidAbhaNumber } from '@/lib/india/abha'

const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.value
}

describe('mockAbdmGateway', () => {
  it('the mock is labelled and accepts only 123456', async () => {
    const m = mockAbdmGateway()
    expect(m.source).toBe('abdm_sandbox_mock')
    expect(m.status()).toEqual({ state: 'mock', label: 'Sandbox mock - not real' })
    const encAadhaar = unwrap(await m.encrypt('234123412346'))
    expect(encAadhaar).not.toContain('234123412346')
    const { txnId } = unwrap(await m.enrolRequestAadhaarOtp({ encryptedAadhaar: encAadhaar }))
    const wrong = unwrap(await m.encrypt('654321'))
    expect(await m.enrolByAadhaarOtp({ txnId, encryptedOtp: wrong, mobile: '9876500903' })).toEqual({ ok: false, error: 'otp_invalid' })
    const right = unwrap(await m.encrypt('123456'))
    const enrolled = unwrap(await m.enrolByAadhaarOtp({ txnId, encryptedOtp: right, mobile: '9876500903' }))
    expect(enrolled.isNew).toBe(true)
    expect(enrolled.profile.abhaNumber).toMatch(/^91\d{12}$/)
    expect(isValidAbhaNumber(enrolled.profile.abhaNumber)).toBe(true)
    expect(enrolled.profile.mobileMasked).toBe('******0903')
    expect(JSON.stringify(enrolled)).not.toContain('234123412346')
  })
  it('is deterministic for the same input', async () => {
    const a = mockAbdmGateway(); const b = mockAbdmGateway()
    const ea = unwrap(await a.encrypt('234123412346')); const eb = unwrap(await b.encrypt('234123412346'))
    expect(ea).toBe(eb)
    expect(unwrap(await a.enrolRequestAadhaarOtp({ encryptedAadhaar: ea }))).toEqual(unwrap(await b.enrolRequestAadhaarOtp({ encryptedAadhaar: eb })))
  })
  it('suggests valid sandbox addresses and accepts the chosen one', async () => {
    const m = mockAbdmGateway()
    const { txnId } = unwrap(await m.enrolRequestAadhaarOtp({ encryptedAadhaar: unwrap(await m.encrypt('234123412346')) }))
    const { suggestions } = unwrap(await m.enrolAddressSuggestions({ txnId }))
    expect(suggestions.length).toBeGreaterThan(0)
    for (const s of suggestions) expect(isValidAbhaAddress(`${s}@sbx`)).toBe(true)
    expect(unwrap(await m.enrolSetAddress({ txnId, abhaAddress: suggestions[0] }))).toEqual({ preferredAbhaAddress: `${suggestions[0]}@sbx` })
  })
  it('mobile login offers fabricated accounts and the chosen one is the profile', async () => {
    const m = mockAbdmGateway()
    const { txnId } = unwrap(await m.loginRequestOtp({ route: 'mobile_otp', encryptedLoginId: unwrap(await m.encrypt('9876500903')) }))
    const v = unwrap(await m.loginVerifyOtp({ route: 'mobile_otp', txnId, encryptedOtp: unwrap(await m.encrypt('123456')) }))
    expect(v.userToken).toBeNull(); expect(v.transientToken).toBeTruthy(); expect(v.accounts.length).toBe(2)
    const { userToken } = unwrap(await m.loginSelectAccount({ transientToken: v.transientToken!, txnId, abhaNumber: v.accounts[1].abhaNumber }))
    expect(unwrap(await m.fetchProfile({ userToken, route: 'mobile_otp' })).abhaNumber).toBe(v.accounts[1].abhaNumber)
    expect(await m.loginSelectAccount({ transientToken: v.transientToken!, txnId, abhaNumber: '91000000000000' })).toEqual({ ok: false, error: 'invalid_input' })
  })
  it('an ABHA-number login verifies that same number', async () => {
    const m = mockAbdmGateway()
    const { txnId } = unwrap(await m.loginRequestOtp({ route: 'abha_number_mobile_otp', encryptedLoginId: unwrap(await m.encrypt('91-1234-5678-9012')) }))
    const v = unwrap(await m.loginVerifyOtp({ route: 'abha_number_mobile_otp', txnId, encryptedOtp: unwrap(await m.encrypt('123456')) }))
    expect(unwrap(await m.fetchProfile({ userToken: v.userToken!, route: 'abha_number_mobile_otp' })).abhaNumber).toBe('91123456789012')
  })
  it('refuses values that were not encrypted by the mock', async () => {
    const m = mockAbdmGateway()
    expect(await m.enrolRequestAadhaarOtp({ encryptedAadhaar: '234123412346' })).toEqual({ ok: false, error: 'invalid_input' })
  })
})
