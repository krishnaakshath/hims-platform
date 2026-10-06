import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { jwtVerify, createRemoteJWKSet } from 'jose'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUER_VALUES = ['https://accounts.google.com', 'accounts.google.com']

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null
function getGoogleJwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))
  return _jwks
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function generateState(): string {
  return randomBytes(16).toString('base64url')
}

// Separate from `state` (CSRF protection for the redirect itself) --
// `nonce` is standard OIDC replay protection: it's echoed back inside the
// signed ID token, so even a token that's otherwise valid (right issuer,
// right audience, right signature) gets rejected if it isn't bound to
// *this* authorization request.
export function generateNonce(): string {
  return randomBytes(16).toString('base64url')
}

// Constant-time comparison so a timing side-channel can't help an attacker
// guess the expected state value -- same discipline as password/OTP
// comparisons elsewhere in this codebase.
//
// The length check MUST compare byte length, not JS string length:
// `timingSafeEqual` throws a RangeError if given two buffers of different
// byte length, and a `state` value containing any multibyte character can
// have equal `.length` (UTF-16 code units) while its UTF-8 byte encoding
// differs in size -- so build the buffers first and compare their lengths,
// not the input strings'.
export function verifyState(expected: string, actual: string): boolean {
  if (!expected || !actual) return false
  const expectedBuf = Buffer.from(expected)
  const actualBuf = Buffer.from(actual)
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge, nonce }: { clientId: string; redirectUri: string; state: string; codeChallenge: string; nonce: string }): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export interface GoogleIdentity {
  sub: string
  email: string
}

interface GoogleTokenResponse {
  id_token?: string
  access_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
  [key: string]: unknown
}

/**
 * Exchanges an authorization code for tokens, then verifies the returned ID
 * token's signature against Google's published JWKS (never trusts an
 * unverified JWT's claims) and checks the issuer/audience/nonce match this
 * app's request before returning the identity it asserts.
 */
export async function exchangeCodeForIdentity({ code, codeVerifier, clientId, clientSecret, redirectUri, nonce }: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string; nonce: string }): Promise<GoogleIdentity> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '')
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${detail}`)
  }
  const tokenJson = (await tokenRes.json()) as GoogleTokenResponse
  const idToken = tokenJson.id_token
  if (!idToken) throw new Error('Google did not return an id_token')

  // RS256 pinned explicitly -- Google's JWKS only ever publishes RSA keys
  // for ID tokens, but pinning the algorithm here closes off any "alg
  // confusion" style attack that relies on the verifier accepting whatever
  // algorithm the token claims to use.
  const { payload } = await jwtVerify(idToken, getGoogleJwks(), { audience: clientId, algorithms: ['RS256'] })
  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUER_VALUES.includes(payload.iss)) {
    throw new Error('Unexpected token issuer')
  }
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Google identity token is missing sub/email')
  }
  // Google allows an account to hold an email it hasn't verified control
  // of. Since the callback keys identity off email in two places (the
  // ADMIN_EMAIL short-circuit and the findUserByEmail fallback), skipping
  // this check would let anyone with a Google account claiming a real
  // staff/admin email address sign in as that person.
  if (payload.email_verified !== true) {
    throw new Error('Google identity token has an unverified email')
  }
  if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) {
    throw new Error('Google identity token nonce does not match this sign-in attempt')
  }

  return { sub: payload.sub, email: payload.email }
}
