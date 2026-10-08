// Wave G P2-01: GET /api/notifications -- the signed-in staff user's notification feed
// (live events for their role) with per-user read state. Not audited: like the nav
// badges it is a worklist summary (at most a patient's name / UHID, for directory roles).
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { NOTIFICATION_FEED_ROLES } from '@/lib/role-policy'
import { getStaffFeed } from '@/lib/queries/staff-notifications'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NOTIFICATION_FEED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    return NextResponse.json(await getStaffFeed(session), { headers: NO_STORE })
  } catch (err) {
    console.error('[notifications] feed failed', err instanceof Error ? err.name : 'error')
    return NextResponse.json({ error: 'Could not load notifications' }, { status: 500 })
  }
}
