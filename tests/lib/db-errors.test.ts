import { describe, it, expect } from 'vitest'
import { isUniqueViolation, isExclusionViolation, isRetryableConflict, pgErrorCode, pgConstraint, RETRY_MESSAGE } from '@/lib/db-errors'

describe('db-errors', () => {
  it('reads the code through a drizzle cause wrapper', () => {
    const wrapped = { message: 'Failed query', cause: { code: '23505', constraint: 'patients_abha_number_unique' } }
    expect(isUniqueViolation(wrapped, 'patients_abha_number_unique')).toBe(true); expect(isExclusionViolation(wrapped)).toBe(false)
  })
  it('reads direct codes and filters by constraint', () => {
    const e = { code: '23P01', constraint: 'x' }
    expect(pgErrorCode(e)).toBe('23P01'); expect(pgConstraint(e)).toBe('x')
    expect(isExclusionViolation(e, 'x')).toBe(true); expect(isExclusionViolation(e, 'y')).toBe(false)
    expect(isUniqueViolation(e)).toBe(false)
  })
  it('handles non-objects', () => {
    expect(pgErrorCode(null)).toBeNull(); expect(pgErrorCode('x')).toBeNull(); expect(pgConstraint(undefined)).toBeNull()
  })
  it('treats a deadlock or serialization failure (also wrapped) as retryable', () => {
    expect(isRetryableConflict({ code: '40P01' })).toBe(true)
    expect(isRetryableConflict({ message: 'Failed query', cause: { code: '40001' } })).toBe(true)
    expect(isRetryableConflict({ code: '23505' })).toBe(false)
    expect(RETRY_MESSAGE).toMatch(/try again/)
  })
})
