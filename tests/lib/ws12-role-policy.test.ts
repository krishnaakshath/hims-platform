import { describe, it, expect } from 'vitest'
import { ADMISSION_COVERAGE_ROLES, COVERAGE_READ_ROLES, COVERAGE_VERIFY_ROLES, POLICY_READ_ROLES, POLICY_WRITE_ROLES } from '@/lib/role-policy'

describe('WS12 coverage roles', () => {
  it('reuse the policy lists and add the admission desks', () => {
    expect(COVERAGE_READ_ROLES).toEqual(POLICY_READ_ROLES)
    expect(COVERAGE_VERIFY_ROLES).toEqual(['admin', 'rcm', 'frontdesk'])
    expect(COVERAGE_VERIFY_ROLES).toEqual(POLICY_WRITE_ROLES)
    expect(ADMISSION_COVERAGE_ROLES).toEqual(['admin', 'frontdesk', 'crc', 'rcm'])
  })
})
