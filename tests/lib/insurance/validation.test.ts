// WS12 T3: the manual verification schema over multipart text fields (R2 bounds, strict keys).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { manualVerificationSchema, manualVerificationMessage } from '@/lib/insurance/validation'

// 2026-10-23 10:00 IST
const NOW = new Date('2026-10-23T04:30:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

const base = { result: 'active', method: 'tpa_portal', reference: 'TPA-REF-1', verifiedOn: '2026-10-23', validUntil: '2026-10-30' }
const parse = (over: Record<string, string | undefined> = {}) => manualVerificationSchema.safeParse({ ...base, ...over })
const message = (over: Record<string, string | undefined>) => {
  const r = parse(over)
  expect(r.success).toBe(false)
  return r.success ? '' : manualVerificationMessage(r.error)
}

describe('manualVerificationSchema', () => {
  it('accepts the minimal manual record and parses numbers from strings, blank as absent', () => {
    const r = parse({ sumInsuredPaise: '50000000', balancePaise: '', copayBp: '1000', roomRentLimitPaise: '400000', icuLimitPaise: '800000', note: '  called the TPA desk  ' })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).toMatchObject({ result: 'active', method: 'tpa_portal', reference: 'TPA-REF-1', sumInsuredPaise: 50_000_000, copayBp: 1000, roomRentLimitPaise: 400_000, icuLimitPaise: 800_000, note: 'called the TPA desk' })
    expect(r.data.balancePaise).toBeUndefined()
  })

  it('names the missing method, a short reference and a wrong result', () => {
    expect(message({ method: undefined })).toBe('Choose how the cover was verified')
    expect(message({ method: 'fax' })).toBe('Choose how the cover was verified')
    expect(message({ reference: ' ab ' })).toBe('Enter the insurer or TPA reference (3 to 64 characters)')
    expect(message({ reference: 'x'.repeat(65) })).toBe('Enter the insurer or TPA reference (3 to 64 characters)')
    expect(message({ result: 'error' })).toBe('Choose whether the policy is active or not in force')
  })

  it('refuses a verified-on date in the future and a valid-until before today', () => {
    expect(message({ verifiedOn: '2026-10-24' })).toBe('The verification date cannot be in the future')
    expect(message({ validUntil: '2026-10-22' })).toBe('Valid until cannot be before today')
    expect(message({ verifiedOn: '23/10/2026' })).toBe('Enter the verification date as YYYY-MM-DD')
    expect(message({ validUntil: '2026-02-30' })).toBe('Enter the valid-until date as YYYY-MM-DD')
  })

  it('allows valid-until up to today + 30 days and refuses beyond', () => {
    expect(parse({ validUntil: '2026-11-22' }).success).toBe(true)
    expect(message({ validUntil: '2026-11-23' })).toBe('Valid until can be at most 30 days from today (22 Nov 2026)')
  })

  it('checks amount and co-pay ranges and whole numbers', () => {
    expect(message({ sumInsuredPaise: '-1' })).toBe('Sum insured must be a whole amount between 0 and ₹10,00,00,00,000')
    expect(message({ balancePaise: '1000000000001' })).toBe('Balance must be a whole amount between 0 and ₹10,00,00,00,000')
    expect(message({ roomRentLimitPaise: '12.5' })).toBe('Room rent limit must be a whole amount between 0 and ₹10,00,00,00,000')
    expect(message({ icuLimitPaise: 'abc' })).toBe('ICU limit must be a whole amount between 0 and ₹10,00,00,00,000')
    expect(message({ copayBp: '10001' })).toBe('Co-pay must be between 0% and 100%')
    expect(parse({ copayBp: '10000', sumInsuredPaise: '1000000000000' }).success).toBe(true)
  })

  it('refuses a note over 500 characters and any unknown field (patient comes from the policy)', () => {
    expect(message({ note: 'n'.repeat(501) })).toBe('Keep the note under 500 characters')
    expect(message({ patientId: 'P-1' })).toBe('Unexpected field in the form')
  })
})
