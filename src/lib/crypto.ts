import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// AES-256-GCM for genuinely sensitive fields (government ID numbers, etc.).
// (This codebase previously also had a lighter-weight `ENC[...]`
// string-wrapping convention for pseudonymous cross-system identifiers
// that weren't PII on the same level as a driver's license/passport
// number -- those identifiers and the fields that held them were removed
// outright by the unified-patient-record migration, so that convention no
// longer has a live use in this codebase.) IDENTITY_ENCRYPTION_KEY must be
// a 32-byte key, base64-encoded.
function getKey(): Buffer {
  const raw = process.env.IDENTITY_ENCRYPTION_KEY
  if (!raw) throw new Error('IDENTITY_ENCRYPTION_KEY is not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('IDENTITY_ENCRYPTION_KEY must decode to exactly 32 bytes')
  return key
}

// Stores iv + authTag + ciphertext as one colon-delimited base64 string so
// decryption never needs a second column.
export function encryptSensitive(plaintext: string): string {
  return encryptWithKey(plaintext, getKey())
}

export function decryptSensitive(stored: string): string {
  // Shape first, key second: a malformed value reports itself as malformed
  // even where the key is unset (unchanged behaviour).
  assertShape(stored)
  return decryptWithKey(stored, getKey())
}

// SP8: the same AES-256-GCM format under a caller-supplied 32-byte key, so
// other at-rest stores (the integration payload vault) use their own key
// instead of the identity key.
function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes')
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  assertKey(key)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

function assertShape(stored: string): [string, string, string] {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error('Malformed encrypted value: expected "iv:authTag:ciphertext"')
  }
  return parts as [string, string, string]
}

export function decryptWithKey(stored: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64] = assertShape(stored)
  assertKey(key)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()])
  return plaintext.toString('utf8')
}
