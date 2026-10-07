import { describe, it, expect } from 'vitest'
import { verhoeffCheckDigit, verhoeffValidate } from '@/lib/india/verhoeff'

describe('verhoeff', () => {
  it('computes the textbook check digit', () => {
    expect(verhoeffCheckDigit('236')).toBe(3)
    expect(verhoeffValidate('2363')).toBe(true)
  })
  it('detects a single-digit error and an adjacent transposition', () => {
    expect(verhoeffValidate('234567890124')).toBe(true)
    expect(verhoeffValidate('234567890125')).toBe(false)
    expect(verhoeffValidate('324567890124')).toBe(false)
  })
  it('throws on non-digit input to the generator', () => {
    expect(() => verhoeffCheckDigit('12a')).toThrow()
  })
  it('returns false for non-digit or empty validation input', () => {
    expect(verhoeffValidate('12a4')).toBe(false)
    expect(verhoeffValidate('')).toBe(false)
  })
})
