import { describe, it, expect, vi, afterEach } from 'vitest'
import { safeLog, safeLogFields, SAFE_LOG_KEYS } from '@/lib/integrations/safe-log'

afterEach(() => vi.restoreAllMocks())

describe('safeLogFields', () => {
  it('keeps only allowlisted, plain values and redacts Aadhaar-like strings', () => {
    expect(safeLogFields({ exchangeId: 7, otp: '123456', aadhaar: '234123412346', errorCode: 'NHCX-1004', patientId: 'RD-1 x' }))
      .toEqual({ exchangeId: 7, errorCode: 'NHCX-1004', patientId: '[dropped]' })
    expect(safeLogFields({ errorCode: '234123412346' }).errorCode).not.toContain('234123412346')
  })
  it('drops objects, nulls, long strings and non-finite numbers', () => {
    expect(safeLogFields({ state: { a: 1 }, action: null, outcome: 'x'.repeat(65), count: Number.NaN, attempt: 2, durationMs: 15.5, capability: true }))
      .toEqual({ state: '[dropped]', action: '[dropped]', outcome: '[dropped]', count: '[dropped]', attempt: 2, durationMs: 15.5, capability: true })
  })
  it('the allowlist is exactly the plan list', () => {
    expect([...SAFE_LOG_KEYS]).toEqual(['exchangeId', 'claimId', 'preauthId', 'patientId', 'checkId', 'shareId', 'action', 'state', 'httpStatus', 'errorCode', 'attempt', 'durationMs', 'correlationPrefix', 'count', 'capability', 'outcome'])
  })
})

describe('safeLog', () => {
  it('writes one console.info line with the tag and the filtered fields', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('abdm', { action: 'enrol/otp', httpStatus: 200, token: 'eyJhbGciOi' })
    expect(spy).toHaveBeenCalledWith('[abdm]', JSON.stringify({ action: 'enrol/otp', httpStatus: 200 }))
    expect(JSON.stringify(spy.mock.calls)).not.toContain('eyJhbGciOi')
  })
})
