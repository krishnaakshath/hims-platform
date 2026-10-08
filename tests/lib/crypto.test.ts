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

// SP8: encryptSensitive / decryptSensitive delegate to the key-parameterised pair.
describe('encryptWithKey / decryptWithKey', () => {
  it('encryptSensitive still round-trips through encryptWithKey', async () => {
    const { encryptWithKey, decryptWithKey } = await import('@/lib/crypto')
    const key = Buffer.from(process.env.IDENTITY_ENCRYPTION_KEY!, 'base64')
    expect(decryptWithKey(encryptSensitive('D1234567'), key)).toBe('D1234567')
    expect(decryptSensitive(encryptWithKey('D1234567', key))).toBe('D1234567')
  })

  it('uses only the key it is given', async () => {
    const { encryptWithKey, decryptWithKey } = await import('@/lib/crypto')
    const { randomBytes } = await import('node:crypto')
    const a = randomBytes(32)
    const b = randomBytes(32)
    const stored = encryptWithKey('{"x":1}', a)
    expect(stored.split(':')).toHaveLength(3)
    expect(decryptWithKey(stored, a)).toBe('{"x":1}')
    expect(() => decryptWithKey(stored, b)).toThrow()
    expect(() => encryptWithKey('x', randomBytes(16))).toThrow(/32 bytes/)
  })
})
