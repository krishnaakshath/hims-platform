import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { demoFeaturesEnabled, DEMO_NOT_CONFIGURED_BODY, DEMO_NOT_CONFIGURED_STATUS } from '@/lib/demo-features'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBroadcasts, listBroadcastRecipientCandidates, sendBroadcast, invalidateBroadcastsList } from '@/lib/queries/broadcasts'
import { trialsEnabled } from '@/lib/features'
import { brand } from '@/lib/brand'
import { BROADCAST_MESSAGE_MAX, summariseAudience, validateAudienceFilters } from '@/lib/broadcasts/audience'

// WS7 T10 (spec D16): a hospital broadcast is one staff-written line sent as the
// `broadcast_notice` template through sendNotification. The sender confirms by typing the
// number of patients who will receive it (confirmCount).
const createBroadcastSchema = z
  .object({
    message: z.string().trim().min(1).max(BROADCAST_MESSAGE_MAX),
    filters: z.record(z.string(), z.unknown()),
    confirmCount: z.number().int().min(0),
  })
  .strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await logAudit(session, 'viewed broadcasts list', null)
  return NextResponse.json(await listBroadcasts())
}

// Sends a broadcast to a patient cohort — LeftNav.tsx:62 —
// { href: '/broadcasts', roles: ['admin', 'crc'] }
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  // Wave B P1-21: the broadcasts area is still behind DEMO_FEATURES (after the role gate, before parsing).
  if (!demoFeaturesEnabled()) return NextResponse.json(DEMO_NOT_CONFIGURED_BODY, { status: DEMO_NOT_CONFIGURED_STATUS })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createBroadcastSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid broadcast payload', details: parsed.error.flatten() }, { status: 400 })
  const audience = validateAudienceFilters(parsed.data.filters, { trialsEnabled: trialsEnabled() })
  if (!audience.ok) {
    const error = audience.code === 'trial_filters_disabled' ? 'Trial filters are not available' : 'Invalid recipient filters'
    return NextResponse.json({ error, code: audience.code }, { status: 400 })
  }

  const members = await listBroadcastRecipientCandidates(audience.filters)
  const counts = summariseAudience(members.map((m) => m.recipientClass))
  if (counts.sendable === 0) {
    return NextResponse.json({ error: 'No patients can receive this broadcast', code: 'empty_audience', counts }, { status: 422 })
  }
  if (parsed.data.confirmCount !== counts.sendable) {
    return NextResponse.json({ error: 'The number of recipients has changed. Check the new count and confirm again.', code: 'count_changed', count: counts.sendable }, { status: 409 })
  }

  const result = await sendBroadcast({ message: parsed.data.message, filters: audience.filters, hospitalName: brand.name, sentBy: session.name, audience: members })
  await invalidateBroadcastsList()
  await logAudit(session, 'sent broadcast', null, `broadcast=${result.id} matched=${counts.match} sent=${result.sentCount} skipped=${result.skippedCount} failed=${result.failedCount}`)
  return NextResponse.json(result, { status: 201 })
}
