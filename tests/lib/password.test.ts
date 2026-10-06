import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '@/lib/password'

describe('hashPassword / verifyPassword', () => {
  it('round-trips the correct password', () => {
    const stored = hashPassword('correct-horse-battery-staple')
    expect(stored).not.toContain('correct-horse-battery-staple')
    expect(verifyPassword('correct-horse-battery-staple', stored)).toBe(true)
  })

  it('rejects an incorrect password', () => {
    const stored = hashPassword('correct-horse-battery-staple')
    expect(verifyPassword('wrong-password', stored)).toBe(false)
  })

  it('produces a different hash each time (random salt)', () => {
    const a = hashPassword('same-password')
    const b = hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(verifyPassword('same-password', a)).toBe(true)
    expect(verifyPassword('same-password', b)).toBe(true)
  })

  it('does not throw on a malformed stored value', () => {
    expect(verifyPassword('anything', 'not-a-valid-hash')).toBe(false)
    expect(verifyPassword('anything', '')).toBe(false)
  })
})
