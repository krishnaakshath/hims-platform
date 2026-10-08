import { importPKCS8, SignJWT } from 'jose'
import type { NhcxConfig } from '@/lib/integrations/config'
import { buildRequestHeaders, type ProtocolHeaders } from '@/lib/nhcx/headers'
import { sealHcxPayload } from '@/lib/nhcx/jwe'
import { makeTestKeyPairAndCert } from './selfsigned'

// Test-only NHCX callback builder: our encryption pair (the JWE recipient),
// NHCX's signing pair (the bearer JWT) and a request factory. Keys are made at
// run time and never written to the repository.
export function makeCallbackKit() {
  const ours = makeTestKeyPairAndCert('P1@sbx', 30)
  const nhcxSigner = makeTestKeyPairAndCert('nhcx-gateway', 30)
  const stranger = makeTestKeyPairAndCert('someone-else', 30)
  const cfg: NhcxConfig = {
    apiBaseUrl: 'https://hcx.example', participantServiceUrl: 'https://hcx.example/p', participantCode: 'P1@sbx', encryptionPrivateKeyPem: ours.privateKeyPem,
    previousEncryptionPrivateKeyPem: null, encryptionCertPem: ours.certPem, gatewaySigningCertPem: nhcxSigner.certPem, callbackIpAllowlist: [], maxAttachmentBytes: 10_000_000,
  }
  async function bearer(signerPem = nhcxSigner.privateKeyPem) {
    return new SignJWT({ participant_code: 'nhcx' }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('5m').sign(await importPKCS8(signerPem, 'RS256'))
  }
  async function request(action: string, fhir: object, over: { headers?: Partial<ProtocolHeaders>; jwt?: string; httpHeaders?: Record<string, string>; now?: Date; status?: ProtocolHeaders['status'] } = {}) {
    const h = { ...buildRequestHeaders({ sender: 'TPA1@sbx', recipient: 'P1@sbx', now: over.now ?? new Date(), status: over.status ?? 'response.complete' }), ...over.headers }
    const jwe = await sealHcxPayload(fhir, h, ours.certPem)
    const body = JSON.stringify({ payload: jwe })
    return {
      headers: h,
      req: new Request(`https://app.example/api/nhcx/callback/${action}`, {
        method: 'POST', body,
        headers: { 'content-length': String(Buffer.byteLength(body)), authorization: `Bearer ${over.jwt ?? (await bearer())}`, 'x-forwarded-for': '10.0.0.9', ...over.httpHeaders },
      }),
    }
  }
  return { cfg, ours, nhcxSigner, stranger, bearer, request }
}
