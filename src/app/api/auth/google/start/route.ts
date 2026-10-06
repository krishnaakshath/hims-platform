import { NextResponse } from 'next/server'
import { generatePkcePair, generateState, generateNonce, buildGoogleAuthUrl } from '@/lib/google-oauth'
import { setPendingGoogleOAuthCookie } from '@/lib/mfa-pending-session'

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!clientId || !appUrl) {
    return NextResponse.json({ error: 'Google sign-in is not configured for this practice yet.' }, { status: 503 })
  }

  const state = generateState()
  const nonce = generateNonce()
  const { verifier, challenge } = generatePkcePair()
  await setPendingGoogleOAuthCookie({ state, codeVerifier: verifier, nonce })

  const authUrl = buildGoogleAuthUrl({
    clientId,
    redirectUri: `${appUrl}/api/auth/google/callback`,
    state,
    codeChallenge: challenge,
    nonce,
  })
  return NextResponse.redirect(authUrl)
}
