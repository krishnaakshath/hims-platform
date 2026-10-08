import { importX509, jwtVerify } from 'jose'

// NHCX callback checks (S3): the caller IP against the operator's allowlist
// (the NAT IPs are listed in docs/ABDM-NHCX.md, not hard-coded; UNVERIFIED
// U6), and the RS256 bearer JWT NHCX signs its calls with, verified against
// NHCX_GATEWAY_SIGNING_CERT. Where that key comes from is UNVERIFIED U6.

export function callerIp(request: Request): string {
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return first && first.length <= 64 ? first : 'unknown'
}

/** True when the allowlist is empty (documented) or the first forwarded hop is in it. */
export function checkCallerIp(request: Request, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true
  return allowlist.includes(callerIp(request))
}

export async function verifyNhcxBearer(request: Request, signingCertPem: string | null, now?: Date): Promise<boolean> {
  if (!signingCertPem) return false
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec((request.headers.get('authorization') ?? '').trim())
  if (!m) return false
  try {
    const key = await importX509(signingCertPem, 'RS256')
    await jwtVerify(m[1], key, { algorithms: ['RS256'], clockTolerance: 60, ...(now ? { currentDate: now } : {}) })
    return true
  } catch {
    return false
  }
}
