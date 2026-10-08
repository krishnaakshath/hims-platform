import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { AbdmConfig } from '@/lib/integrations/config'

// ABDM callback authenticity (S1 concepts/callback-authenticity.mdx): every
// gateway callback carries `Authorization: Bearer <JWT>` signed by the gateway
// (RS256 with a `kid`, S1 [observed, annex]). The key-set URL is UNVERIFIED
// U13: the operator sets ABDM_GATEWAY_JWKS_URL to the URL NHA confirms at
// onboarding; if that URL needs the session token, the route passes a JWKS
// getter that adds it. No JWKS URL means Scan & Share is not configured.

export type CallbackAuthResult = { ok: true } | { ok: false; status: 401 | 403 | 503 }

const remoteSets = new Map<string, JWTVerifyGetKey>()
function remoteJwks(url: string): JWTVerifyGetKey {
  let set = remoteSets.get(url)
  if (!set) {
    set = createRemoteJWKSet(new URL(url))
    remoteSets.set(url, set)
  }
  return set
}

export async function verifyAbdmCallback(
  request: Request,
  cfg: AbdmConfig,
  deps: { jwks?: JWTVerifyGetKey; now?: Date } = {},
): Promise<CallbackAuthResult> {
  if (!cfg.gatewayJwksUrl || !cfg.hipId) return { ok: false, status: 503 }
  const header = request.headers.get('authorization') ?? ''
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim())
  if (!m) return { ok: false, status: 401 }
  try {
    await jwtVerify(m[1], deps.jwks ?? remoteJwks(cfg.gatewayJwksUrl), {
      algorithms: ['RS256'],
      clockTolerance: 60,
      ...(deps.now ? { currentDate: deps.now } : {}),
    })
  } catch {
    return { ok: false, status: 401 }
  }
  if (request.headers.get('x-hip-id') !== cfg.hipId) return { ok: false, status: 403 }
  return { ok: true }
}
