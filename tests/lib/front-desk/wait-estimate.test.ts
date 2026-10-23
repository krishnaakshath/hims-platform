import { describe, it, expect } from 'vitest'
import { estimateWaitMinutes } from '@/lib/front-desk/wait-estimate'

// WS6 T9: the front desk's wait estimate -- patients ahead times the doctor's slot length.
describe('estimateWaitMinutes', () => {
  it('is patients ahead times the slot length', () => {
    expect(estimateWaitMinutes(3, 10)).toBe(30)
    expect(estimateWaitMinutes(2, 15)).toBe(30)
  })

  it('is 0 with nobody ahead', () => {
    expect(estimateWaitMinutes(0, 20)).toBe(0)
    expect(estimateWaitMinutes(0, null)).toBe(0)
  })

  it('assumes 10 minutes a patient when the slot length is unknown', () => {
    expect(estimateWaitMinutes(4, null)).toBe(40)
  })

  it('caps the estimate at 240 minutes', () => {
    expect(estimateWaitMinutes(30, 15)).toBe(240)
  })

  it('gives no estimate for a nonsensical count', () => {
    expect(estimateWaitMinutes(-1, 10)).toBeNull()
    expect(estimateWaitMinutes(Number.NaN, 10)).toBeNull()
  })
})
