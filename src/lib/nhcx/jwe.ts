import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, importPKCS8, importX509 } from 'jose'
import { JWE_ALG_SEND, JWE_ALGS_ACCEPT, JWE_ENC } from './constants'
import { toJoseHeader, type ProtocolHeaders } from './headers'

// HCX JWE (S4 v0.8; S3 for NHCX's RSA-OAEP-256): the FHIR payload encrypted
// to the recipient's certificate, with the protocol headers in the protected
// header. Opening tries the current private key, then the previous one
// (rotation). An alg outside the accept list is refused before any key is
// tried. Named differently from the at-rest vault's sealPayload on purpose.

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function sealHcxPayload(fhir: object, headers: ProtocolHeaders, recipientCertPem: string): Promise<string> {
  const key = await importX509(recipientCertPem, JWE_ALG_SEND)
  return new CompactEncrypt(enc.encode(JSON.stringify(fhir)))
    .setProtectedHeader({ alg: JWE_ALG_SEND, enc: JWE_ENC, ...toJoseHeader(headers) })
    .encrypt(key)
}

export type OpenResult =
  | { ok: true; protectedHeader: Record<string, unknown>; fhir: unknown }
  | { ok: false; problem: 'decrypt_failed' | 'bad_alg' | 'not_json' }

export async function openHcxPayload(compact: string, privateKeysPem: string[]): Promise<OpenResult> {
  let alg: unknown
  let encAlg: unknown
  try {
    const h = decodeProtectedHeader(compact)
    alg = h.alg
    encAlg = h.enc
  } catch {
    return { ok: false, problem: 'decrypt_failed' }
  }
  if (typeof alg !== 'string' || !(JWE_ALGS_ACCEPT as readonly string[]).includes(alg) || encAlg !== JWE_ENC) return { ok: false, problem: 'bad_alg' }

  for (const pem of privateKeysPem) {
    let plaintext: Uint8Array
    let protectedHeader: Record<string, unknown>
    try {
      const key = await importPKCS8(pem, alg)
      const r = await compactDecrypt(compact, key, { keyManagementAlgorithms: [...JWE_ALGS_ACCEPT], contentEncryptionAlgorithms: [JWE_ENC] })
      plaintext = r.plaintext
      protectedHeader = r.protectedHeader as Record<string, unknown>
    } catch {
      continue
    }
    try {
      return { ok: true, protectedHeader, fhir: JSON.parse(dec.decode(plaintext)) }
    } catch {
      return { ok: false, problem: 'not_json' }
    }
  }
  return { ok: false, problem: 'decrypt_failed' }
}

/** The HCX request body (S4): `{ "payload": "<compact JWE>" }`. */
export function envelope(compact: string): { payload: string } {
  return { payload: compact }
}
