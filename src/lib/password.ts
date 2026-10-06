import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const KEY_LENGTH = 64
// Node's scryptSync defaults to N=16384, below current OWASP guidance
// (N=2^17=131072, r=8, p=1) -- a security audit flagged this as
// under-provisioned for an admin credential. Node's memory guard rejects
// this cost with the default 32MB maxmem, since scrypt needs roughly
// 128*N*r bytes; pass an explicit ceiling comfortably above that.
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

export function hashPassword(plaintext: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(plaintext, salt, KEY_LENGTH, SCRYPT_OPTIONS).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(plaintext, salt, KEY_LENGTH, SCRYPT_OPTIONS)
  const expected = Buffer.from(hash, 'hex')
  // Guard the length before timingSafeEqual, which throws on a mismatch
  // instead of returning false -- an attacker-controlled hash length here
  // would otherwise crash the request rather than fail the login cleanly.
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
