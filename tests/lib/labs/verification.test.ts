// WS4 T11: the verification denial table (spec 3.4).
import { describe, it, expect } from 'vitest'
import { VERIFY_DENIAL_MESSAGE, verificationDenial } from '@/lib/labs/verification'

const LAB = 7
const GEN_MED = 3
const PATHOLOGIST_USER = 41
const TECH_USER = 42
const base = { status: 'resulted' as const, verifierDepartmentId: LAB, testDepartmentId: LAB, verifierUserId: PATHOLOGIST_USER, resultedByUserId: TECH_USER }

describe('verificationDenial', () => {
  it('a pathologist (linked to LAB) may verify a LAB test entered by someone else', () => {
    expect(verificationDenial(base)).toBeNull()
  })

  it('the same user who entered the result is refused (self_verification)', () => {
    expect(verificationDenial({ ...base, resultedByUserId: PATHOLOGIST_USER })).toBe('self_verification')
  })

  it('a general physician (GEN_MED) is refused on a LAB test (wrong_department)', () => {
    expect(verificationDenial({ ...base, verifierDepartmentId: GEN_MED })).toBe('wrong_department')
  })

  it('an unlinked lab technician is refused (not_linked)', () => {
    expect(verificationDenial({ ...base, verifierDepartmentId: null, verifierUserId: TECH_USER })).toBe('not_linked')
  })

  it('an order still at the bench (received) is not_resulted', () => {
    expect(verificationDenial({ ...base, status: 'received' })).toBe('not_resulted')
    expect(verificationDenial({ ...base, status: 'verified' })).toBe('not_resulted')
  })

  it('a test without a reporting department cannot be verified by anyone', () => {
    expect(verificationDenial({ ...base, testDepartmentId: null })).toBe('wrong_department')
  })

  it('an LIS result (no enterer user) is verifiable by the department', () => {
    expect(verificationDenial({ ...base, resultedByUserId: null })).toBeNull()
  })

  it('has the fixed not_linked message', () => {
    expect(VERIFY_DENIAL_MESSAGE.not_linked).toBe('Verification needs a pathologist or reporting specialist account linked to a provider. Settings → Staff.')
  })
})
