// Wave J (P1-20): identifier parsing for the portal's UHID / mobile OTP sign-in.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { formatUhid } from '@/lib/uhid'
import { isSmsSignInConfigured, parsePortalOtpIdentifier, portalOtpIdentifierKey, portalOtpIdentity, toIndianE164 } from '@/lib/patient-portal-otp'

const UHID = formatUhid('HIMS', 42)

afterEach(() => { vi.unstubAllEnvs() })

describe('parsePortalOtpIdentifier', () => {
  it('accepts a valid UHID in any case', () => {
    expect(parsePortalOtpIdentifier(` ${UHID.toLowerCase()} `)).toEqual({ kind: 'uhid', uhid: UHID })
  })

  it('rejects a UHID with a bad check digit (falls through to "not a mobile")', () => {
    const bad = UHID.slice(0, -1) + String((Number(UHID.slice(-1)) + 1) % 10)
    expect(parsePortalOtpIdentifier(bad)).toBeNull()
  })

  it.each(['9845000001', '+91 98450 00001', '919845000001', '09845000001', '98450-00001'])('accepts the mobile %s', (raw) => {
    expect(parsePortalOtpIdentifier(raw)).toEqual({ kind: 'mobile', last10: '9845000001' })
  })

  it.each(['12345', '5845000001', 'RD-0001', 'name@example.com', '', '98450000011234'])('rejects %s', (raw) => {
    expect(parsePortalOtpIdentifier(raw)).toBeNull()
  })

  it('keys every spelling of one identifier to one bucket', () => {
    expect(portalOtpIdentifierKey(parsePortalOtpIdentifier('+91 98450 00001')!)).toBe(portalOtpIdentifierKey(parsePortalOtpIdentifier('9845000001')!))
    expect(portalOtpIdentifierKey(parsePortalOtpIdentifier(UHID.toLowerCase())!)).toBe(`portal:uhid:${UHID}`)
    expect(portalOtpIdentity('RD-0001')).toBe('patient-portal:RD-0001')
  })
})

describe('toIndianE164 / isSmsSignInConfigured', () => {
  it('normalizes a stored Indian mobile', () => {
    expect(toIndianE164('+91 98450 00001')).toBe('+919845000001')
    expect(toIndianE164('020 2612 3456')).toBeNull()
  })

  it('needs all three gateway settings', () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'a')
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'b')
    vi.stubEnv('TWILIO_FROM_NUMBER', '')
    expect(isSmsSignInConfigured()).toBe(false)
    vi.stubEnv('TWILIO_FROM_NUMBER', '+10000000000')
    expect(isSmsSignInConfigured()).toBe(true)
  })
})
