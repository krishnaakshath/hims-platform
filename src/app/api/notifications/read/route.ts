// Wave G P2-01: POST /api/notifications/read -- mark feed items read for the signed-in
// user: { keys: [...] } or { all: true }. Only keys in the user's current feed are
// stored (see markStaffNotificationsRead); returns the updated feed.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { NOTIFICATION_FEED_ROLES } from '@/lib/role-policy'
import { NOTIFICATION_KEY_RE } from '@/lib/notifications/staff-feed'
import { markStaffNotificationsRead } from '@/lib/queries/staff-notifications'

const bodySchema = z.union([
  z.object({ keys: z.array(z.string().regex(NOTIFICATION_KEY_RE)).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
])

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NOTIFICATION_FEED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bodySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  try {
    const feed = await markStaffNotificationsRead(session, 'keys' in parsed.data ? parsed.data.keys : null)
    return NextResponse.json(feed, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[notifications] mark read failed', err instanceof Error ? err.name : 'error')
    return NextResponse.json({ error: 'Could not update notifications' }, { status: 500 })
  }
}
