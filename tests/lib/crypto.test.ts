import { describe, it, expect } from 'vitest'
import { encryptSensitive, decryptSensitive } from '@/lib/crypto'

describe('encryptSensitive / decryptSensitive', () => {
  it('round-trips a plaintext value', () => {
    const plaintext = 'D1234567'
    const encrypted = encryptSensitive(plaintext)
    expect(encrypted).not.toContain(plaintext)
    expect(decryptSensitive(encrypted)).toBe(plaintext)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSensitive('P9988776')
    const b = encryptSensitive('P9988776')
    expect(a).not.toBe(b)
    expect(decryptSensitive(a)).toBe('P9988776')
    expect(decryptSensitive(b)).toBe('P9988776')
  })

  it('throws on a tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encryptSensitive('S7654321')
    const [iv, authTag, ciphertext] = encrypted.split(':')
    const tampered = [iv, authTag, ciphertext.slice(0, -4) + 'AAAA'].join(':')
    expect(() => decryptSensitive(tampered)).toThrow()
  })

  it('throws a clear error on a malformed stored value instead of an opaque Buffer crash', () => {
    expect(() => decryptSensitive('')).toThrow(/malformed/i)
    expect(() => decryptSensitive('not-the-right-shape')).toThrow(/malformed/i)
    expect(() => decryptSensitive('a:b')).toThrow(/malformed/i)
    expect(() => decryptSensitive('a::c')).toThrow(/malformed/i)
  })
})
