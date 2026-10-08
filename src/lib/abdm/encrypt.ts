import { constants, createPublicKey, publicEncrypt } from 'node:crypto'

// ABHA V3 field encryption: RSA/ECB/OAEPWithSHA-1AndMGF1Padding under the ABHA
// public certificate (S1 concepts/encryption.mdx). Node's `oaepHash` sets both
// the OAEP digest and MGF1, so SHA-1 is used for both. This is raw RSA over a
// short string, not a JOSE operation (ruling 3).
//
// Failures throw a fixed message with no `cause`, so neither the plaintext
// (a national ID number, an OTP, a login id) nor a crypto error that might
// quote it can reach a log or a response.

export class AbdmEncryptionError extends Error {
  constructor() {
    super('Could not encrypt for ABDM')
    this.name = 'AbdmEncryptionError'
  }
}

export function encryptForAbdm(plaintext: string, publicKeySpkiBase64: string): string {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(plaintext, 'utf8')).toString('base64')
  } catch {
    throw new AbdmEncryptionError()
  }
}
