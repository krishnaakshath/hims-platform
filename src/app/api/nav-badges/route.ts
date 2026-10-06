import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { loadNavBadges } from '@/lib/nav-badges'

// Live LeftNav counts. The dashboard layout computes the initial badges on
// a full render only (layouts don't re-render on client navigation), so the
// client polls this to keep them fresh. Response: {badges, degraded}.
//   - badges[href] = count, or null when that badge is intentionally
//     suppressed (e.g. a pi with no matched provider);
//   - degraded: true means computing failed and badges is {} -- the client
//     must keep what it last showed, never read it as 0.
// Reading the session cookie makes this handler dynamic; no-store also keeps
// browsers and proxies from serving a stale count.
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const result = await loadNavBadges(session)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
