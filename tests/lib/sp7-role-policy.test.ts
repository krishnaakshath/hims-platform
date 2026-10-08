import { describe, it, expect } from 'vitest'
import {
  searchScopesFor, CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, CHARGES_ROLES, BILLING_AUTHORITY_ROLES, CASH_DESK_ROLES,
  CODING_ROLES, INSURANCE_CARD_READ_ROLES, TARIFF_LOOKUP_ROLES, CODE_LOOKUP_ROLES,
  RCM_ROLES, PAYER_MASTER_ROLES, RCM_SETTINGS_ROLES, POLICY_READ_ROLES, POLICY_WRITE_ROLES,
  PREAUTH_LOOKUP_ROLES, WRITE_OFF_APPROVE_ROLES, CLAIM_ABHA_READ_ROLES,
} from '@/lib/role-policy'

describe('SP7 role policy', () => {
  it('every SP7 allowlist is exactly as specified', () => {
    expect(RCM_ROLES).toEqual(['admin', 'rcm']); expect(PAYER_MASTER_ROLES).toEqual(['admin', 'rcm']); expect(RCM_SETTINGS_ROLES).toEqual(['admin'])
    expect(POLICY_READ_ROLES).toEqual(['admin', 'rcm', 'frontdesk', 'billing', 'crc']); expect(POLICY_WRITE_ROLES).toEqual(['admin', 'rcm', 'frontdesk'])
    expect(PREAUTH_LOOKUP_ROLES).toEqual(['admin', 'rcm', 'billing', 'crc']); expect(WRITE_OFF_APPROVE_ROLES).toEqual(['admin']); expect(CLAIM_ABHA_READ_ROLES).toEqual(['admin', 'rcm'])
  })

  it('rcm has no search, clinical, directory, coding or SP4 billing powers, and only the two lookups', () => {
    // Wave G: TARIFF_LOOKUP_ROLES search the service catalogue; rcm searches services only, never patients.
    expect(searchScopesFor('rcm')).toEqual({ patients: false, trials: false, formTemplates: false, services: true })
    for (const l of [CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, CHARGES_ROLES, BILLING_AUTHORITY_ROLES, CASH_DESK_ROLES, CODING_ROLES, INSURANCE_CARD_READ_ROLES]) expect(l).not.toContain('rcm')
    expect(TARIFF_LOOKUP_ROLES).toContain('rcm'); expect(CODE_LOOKUP_ROLES).toContain('rcm')
  })
})
