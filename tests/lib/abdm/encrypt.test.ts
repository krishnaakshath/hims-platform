import { describe, it, expect } from 'vitest'
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { AbdmEncryptionError, encryptForAbdm } from '@/lib/abdm/encrypt'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 })
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

describe('encryptForAbdm', () => {
  it('encrypts with OAEP SHA-1 so ABDM can decrypt', () => {
    const ct = encryptForAbdm('123456', spki)
    expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(ct, 'base64')).toString()).toBe('123456')
    expect(() => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(ct, 'base64'))).toThrow()
  })
  it('is randomised (OAEP), so the same input never repeats', () => {
    expect(encryptForAbdm('123456', spki)).not.toBe(encryptForAbdm('123456', spki))
  })
  it('encryptForAbdm never returns or throws the plaintext', () => {
    const secret = '234123412346'
    let msg = ''
    let err: unknown
    try { encryptForAbdm(secret, 'not-a-key') } catch (e) { err = e; msg = String(e) + JSON.stringify(e) + String((e as Error).cause ?? '') + String((e as Error).stack ?? '') }
    expect(err).toBeInstanceOf(AbdmEncryptionError)
    expect(msg).toContain('Could not encrypt for ABDM'); expect(msg).not.toContain(secret)
    expect((err as Error).cause).toBeUndefined()
    expect(encryptForAbdm(secret, spki)).not.toContain(secret)
  })
})
