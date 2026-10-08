import { decryptWithKey, encryptWithKey } from '@/lib/crypto'

// At-rest sealing for integration payloads (inbound NHCX FHIR, the stored
// outbound JWE kept for identical retries, ABHA flow-store entries). Its own
// key, INTEGRATION_PAYLOAD_KEY (32 bytes, base64), never the identity key
// (SP8 ruling 3). Errors never carry the key or the payload.

function payloadKey(): Buffer {
  const raw = process.env.INTEGRATION_PAYLOAD_KEY
  if (!raw) throw new Error('INTEGRATION_PAYLOAD_KEY is not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('INTEGRATION_PAYLOAD_KEY must decode to exactly 32 bytes')
  return key
}

export function sealPayload(json: string): string {
  return encryptWithKey(json, payloadKey())
}

export function openPayload(stored: string): string {
  return decryptWithKey(stored, payloadKey())
}
