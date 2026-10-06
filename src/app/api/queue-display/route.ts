import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getQueueDisplayPin } from '@/lib/queries/settings'
import { getQueueDisplayRows } from '@/lib/queries/queue-display'
import { checkQueueDisplayPinRateLimit } from '@/lib/rate-limit'

const PIN_HEADER = 'x-queue-display-pin'

// Same client-IP derivation as src/app/api/login/route.ts's getClientIp --
// Vercel/most proxies set the real client IP as the first x-forwarded-for
// entry; NextRequest no longer exposes `.ip` directly.
function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

// Constant-time PIN comparison -- same discipline as verifyPassword
// (password.ts) and verifyState (google-oauth.ts): guard the byte length
// before timingSafeEqual, which throws (rather than returning false) on a
// length mismatch, so an attacker-controlled PIN length can't crash the
// request, and a timing side-channel can't help narrow down the real PIN
// character by character.
function pinsMatch(supplied: string, stored: string): boolean {
  const suppliedBuf = Buffer.from(supplied)
  const storedBuf = Buffer.from(stored)
  return suppliedBuf.length === storedBuf.length && timingSafeEqual(suppliedBuf, storedBuf)
}

// Deliberately does NOT call requireSession() -- this backs a lobby TV with
// no staff login (spec §3), gated instead by a shared PIN checked against
// appSettings.queueDisplayPin. An unset PIN fails closed (401), never
// silently serves real data with no gate at all.
export async function GET(request: NextRequest) {
  // Rate-limited before the PIN check itself: like every other unauthenticated
  // secret-checking endpoint in this codebase (see src/lib/rate-limit.ts),
  // this throttles brute-force PIN guessing and caps the DB round-trip a
  // failed check would otherwise cost on every single unthrottled request.
  const ip = getClientIp(request)
  const { allowed } = await checkQueueDisplayPinRateLimit(ip)
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 })
  }

  const storedPin = await getQueueDisplayPin()
  const suppliedPin = request.headers.get(PIN_HEADER)
  if (!storedPin || !suppliedPin || !pinsMatch(suppliedPin, storedPin)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const tickets = await getQueueDisplayRows()
  return NextResponse.json({ tickets })
}
