import { describe, it, expect } from 'vitest'
import { sha256Hex, snapshotSha256 } from '@/lib/rcm/hash'

describe('RCM hashes', () => {
  it('hashes bytes and strings, and snapshots key-order independently', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
    expect(snapshotSha256({ a: 1, b: [2] })).toBe(snapshotSha256({ b: [2], a: 1 }))
  })
})
