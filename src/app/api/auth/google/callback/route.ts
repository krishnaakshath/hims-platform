import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForIdentity, verifyState } from '@/lib/google-oauth'
import { getPendingGoogleOAuth, clearPendingGoogleOAuthCookie } from '@/lib/mfa-pending-session'
import { setSessionCookie } from '@/lib/auth'
import { findUserByEmail } from '@/lib/queries/users'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { brand } from '@/lib/brand'

export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!clientId || !clientSecret || !appUrl) {
    return NextResponse.json({ error: 'Google sign-in is not configured for this practice yet.' }, { status: 503 })
  }

  // `new URL(request.url)` rather than `request.nextUrl` -- this route is
  // exercised in tests with a plain Web `Request` (no `.nextUrl` extension),
  // matching the same pattern already used by appointments/reviews/search's
  // route handlers.
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return NextResponse.json({ error: 'Invalid Google sign-in response' }, { status: 400 })

  const pending = await getPendingGoogleOAuth()
  const stateValid = pending ? verifyState(pending.state, state) : false
  // Clear the pending cookie on every path -- success or failure -- so a
  // rejected attempt (bad/replayed state, expired cookie) doesn't leave a
  // still-live 5-minute pending cookie sitting around for a follow-up try.
  await clearPendingGoogleOAuthCookie()
  if (!pending || !stateValid) {
    return NextResponse.json({ error: 'This sign-in link has expired or is invalid. Please try again.' }, { status: 400 })
  }

  let identity
  try {
    identity = await exchangeCodeForIdentity({
      code,
      codeVerifier: pending.codeVerifier,
      clientId,
      clientSecret,
      redirectUri: `${appUrl}/api/auth/google/callback`,
      nonce: pending.nonce,
    })
  } catch (err) {
    // Never reflect the raw upstream error back to an unauthenticated
    // caller -- it can carry Google's token-endpoint response body or
    // jose's internal verification message, both of which are internal
    // diagnostic detail, not something to hand to whoever hit this URL.
    console.error('Google OAuth callback failed to exchange/verify identity:', err)
    return NextResponse.json({ error: 'Could not verify your Google sign-in. Please try again.' }, { status: 400 })
  }

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH
  // Also requires ADMIN_PASSWORD_HASH to be configured, matching the same
  // precondition the password-login path enforces (src/app/api/login/route.ts)
  // -- a deployment that never set up the password-based admin account
  // shouldn't be reachable as admin via SSO alone.
  if (adminEmail && adminPasswordHash && identity.email.toLowerCase() === adminEmail.toLowerCase()) {
    await setSessionCookie('admin', process.env.ADMIN_NAME ?? 'Admin', null)
    await logAudit({ role: 'admin', name: process.env.ADMIN_NAME ?? 'Admin', userId: null }, 'logged in via Google SSO', null)
    return NextResponse.redirect(`${appUrl}/`)
  }

  // googleSub first (a real link from a prior sign-in), then email as a
  // fallback for a first-ever Google sign-in on an existing account -- never
  // creates a row that doesn't already exist (see spec §5: SSO never
  // auto-provisions staff).
  const [bySub] = await getDb().select().from(users).where(eq(users.googleSub, identity.sub))
  const user = bySub ?? (await findUserByEmail(identity.email))
  if (!user) {
    return NextResponse.json({ error: `No ${brand.name} account is linked to this Google account. Ask an admin to add you.` }, { status: 403 })
  }

  if (!bySub) {
    if (user.googleSub && user.googleSub !== identity.sub) {
      // Matched by email, but this account is already linked to a
      // *different* Google identity -- silently relinking here would let
      // whoever controls the new Google account take over this user's
      // session here just by sharing its email address.
      return NextResponse.json({ error: 'This account is already linked to a different Google account.' }, { status: 403 })
    }
    if (!user.googleSub) {
      await getDb().update(users).set({ googleSub: identity.sub }).where(eq(users.id, user.id))
    }
  }

  await setSessionCookie(user.role, user.name, user.id)
  await logAudit({ role: user.role, name: user.name, userId: user.id }, 'logged in via Google SSO', null)
  return NextResponse.redirect(`${appUrl}/`)
}
