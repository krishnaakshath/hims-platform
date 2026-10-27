import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { trialsEnabled } from '@/lib/features'
import { listBroadcastRecipientCandidates } from '@/lib/queries/broadcasts'
import { parseAudienceQuery, summariseAudience } from '@/lib/broadcasts/audience'

// WS7 T10: live audience preview for the broadcast wizard. Returns the counts ("212 match ·
// 18 opted out · 7 no phone") and the patients who would be sent the notice (UHID and name only,
// never a phone or email). Trial filters are refused unless trialsEnabled().
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = parseAudienceQuery(new URL(request.url).searchParams, { trialsEnabled: trialsEnabled() })
  if (!parsed.ok) {
    const error = parsed.code === 'trial_filters_disabled' ? 'Trial filters are not available' : 'Invalid recipient filters'
    return NextResponse.json({ error, code: parsed.code }, { status: 400 })
  }

  const members = await listBroadcastRecipientCandidates(parsed.filters)
  const counts = summariseAudience(members.map((m) => m.recipientClass))
  const recipients = members.filter((m) => m.recipientClass === 'send').map((m) => ({ id: m.id, uhid: m.uhid, name: m.name }))
  return NextResponse.json({ counts, recipients })
}
