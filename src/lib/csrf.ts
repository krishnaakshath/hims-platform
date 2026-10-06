import { NextRequest, NextResponse } from 'next/server'

// Every other state-changing route in this app is called via fetch() with a
// JSON body, which browsers can't send from a plain cross-site HTML <form>
// (forms are limited to form-urlencoded/multipart/text-plain) -- that alone
// rules out the classic CSRF form-post attack for those routes. The identity
// match confirm/reject routes are the one exception: the queue page
// deliberately submits them as real <form method="post"> elements (see the
// comment in confirm/route.ts) so a plain click works without JS, which
// means a malicious page could embed the same form and submit it
// cross-site using the admin's real session cookie. Reject any POST here
// whose Origin doesn't match this app's own origin.
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin')
  if (!origin) return null // same-origin form posts don't always send Origin; Referer isn't reliable either -- absence isn't itself the attack
  if (origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  }
  return null
}
