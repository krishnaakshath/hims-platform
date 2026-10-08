import { describe, it, expect } from 'vitest'
import {
  ABHA_LINK_ROLES, ABDM_SHARE_QUEUE_ROLES, NHCX_ELIGIBILITY_ROLES, NHCX_EXCHANGE_ROLES, INTEGRATION_SETTINGS_ROLES, POLICY_READ_ROLES,
} from '@/lib/role-policy'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'

describe('SP8 role policy', () => {
  it('SP8 allowlists are exact', () => {
    expect(ABHA_LINK_ROLES).toEqual(['admin', 'frontdesk', 'crc']); expect(ABDM_SHARE_QUEUE_ROLES).toEqual(['admin', 'frontdesk'])
    expect(NHCX_ELIGIBILITY_ROLES).toEqual(['admin', 'rcm', 'frontdesk', 'billing', 'crc']); expect(NHCX_EXCHANGE_ROLES).toEqual(['admin', 'rcm']); expect(INTEGRATION_SETTINGS_ROLES).toEqual(['admin'])
  })
  it('eligibility readers are the SP7 policy readers', () => {
    expect([...NHCX_ELIGIBILITY_ROLES]).toEqual([...POLICY_READ_ROLES])
  })
  it('the capability bullets describe the SP8 grants', () => {
    const has = (role: keyof typeof ROLE_CAPABILITIES, text: string) => ROLE_CAPABILITIES[role].bullets.includes(text)
    expect(has('admin', 'Connect the hospital to ABDM and NHCX and test the connection')).toBe(true)
    for (const r of ['frontdesk', 'crc'] as const) expect(has(r, 'Create or verify a patient\'s ABHA with the patient\'s consent')).toBe(true)
    expect(has('frontdesk', 'Register patients who share their ABHA profile by scanning the desk QR code')).toBe(true)
    expect(has('crc', 'Register patients who share their ABHA profile by scanning the desk QR code')).toBe(false)
    expect(has('rcm', 'Send pre-authorisations and claims through NHCX and review insurer responses')).toBe(true)
  })
})
