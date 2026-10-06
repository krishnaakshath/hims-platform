import { NextRequest, NextResponse } from 'next/server'
import { parseSessionCookie } from '@/lib/auth'
import { cookieName } from '@/lib/brand'

// Same helper auth.ts uses to WRITE this cookie -- a name mismatch here would
// redirect every signed-in user to /login.
const SESSION_COOKIE_NAME = cookieName('session')

export async function proxy(request: NextRequest) {
  const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value
  const hasValidSession = raw ? (await parseSessionCookie(raw)) !== null : false

  if (!hasValidSession && !request.nextUrl.pathname.startsWith('/login')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

// patient-portal is excluded the same way intake is: it's a separate
// patient-facing area gated by its own session mechanism
// (lib/patient-session.ts, a distinct cookie), not this staff session --
// without this exclusion every patient-portal request would get redirected
// to the staff /login page before patient-portal's own auth check ever runs.
// icon is excluded because it's the app's generated favicon (src/app/icon.tsx)
// -- browsers request it directly, with no session cookie, on every page
// including /login itself, so gating it here would leave the browser tab
// with a broken icon for anyone not currently signed in.
// branding is excluded because it's static logo assets (public/branding/*)
// referenced directly by <img> tags on unauthenticated pages (both login
// screens, the intake portal) -- without this exclusion those requests hit
// this same staff-session gate and redirect to /login, breaking the image.
// telemedicine/join is excluded the same way intake and patient-portal are:
// it's the patient-facing video-visit join page, gated by its own
// single-use join token (see src/app/telemedicine/join/[token]/page.tsx),
// not a staff session. Found and fixed during this task's real-dev-server
// verification -- without this exclusion, a real patient clicking their
// join link would be bounced to the staff /login page instead of reaching
// the call. Deliberately scoped to /telemedicine/join only (not all of
// /telemedicine): the provider call screen at /telemedicine/[sessionId] is
// staff-session-gated on purpose and must keep redirecting to /login.
// display/queue is excluded because it's the lobby queue screen (spec §3):
// a TV with no staff logged in, gated instead by its own PIN check against
// appSettings.queueDisplayPin (see src/app/api/queue-display/route.ts) --
// without this exclusion every request from that unattended screen would
// get redirected to /login before ever reaching the PIN gate. Scoped to
// the exact `display/queue` path segment (not a bare `display` prefix) so
// this exclusion can never over-match a future unrelated `/display-*`
// route -- there is exactly one route under /display today and none other
// planned, so this costs nothing to tighten now.
// book is excluded the same way: /book (src/app/book/page.tsx) is the public
// booking-request widget -- a cold, unauthenticated visitor from the
// practice's public website, with no account and no staff-sent token.
// Placing it outside the (dashboard) route group only avoids that layout's
// own getSession() check; without this exclusion too, this proxy's
// codebase-wide session gate would still redirect every /book request to
// /login before the page ever rendered. Anchored to book(?:/|$) (not a bare
// `book` prefix) so it can never over-match /booking-requests, the STAFF
// confirm/decline queue, which must keep requiring a session.
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon|branding|intake|patient-portal|telemedicine/join|display/queue|book(?:/|$)).*)'] }
