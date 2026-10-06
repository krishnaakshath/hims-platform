import { describe, it, expect } from 'vitest'
import { luhnCheck } from '@/lib/mock-payment'

describe('luhnCheck', () => {
  it('accepts a well-known Luhn-valid test card number', () => {
    expect(luhnCheck('4242424242424242')).toBe(true)
  })

  it('rejects a number that fails the Luhn checksum', () => {
    expect(luhnCheck('4242424242424241')).toBe(false)
  })

  it('rejects a too-short number', () => {
    expect(luhnCheck('4242')).toBe(false)
  })

  it('ignores spaces and dashes in the input', () => {
    expect(luhnCheck('4242 4242 4242 4242')).toBe(true)
    expect(luhnCheck('4242-4242-4242-4242')).toBe(true)
  })
})
