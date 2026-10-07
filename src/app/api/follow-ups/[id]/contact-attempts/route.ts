import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { FOLLOW_UP_BOOKING_ROLES } from '@/lib/role-policy'
import { contactAttemptSchema } from '@/lib/follow-ups/validation'
import { recordContactAttempt } from '@/lib/queries/follow-up-recall'
import type { ContactAttemptView } from '@/lib/follow-ups/view'
import {
  FOLLOW_UP_CLOSED, FOLLOW_UP_NOT_FOUND, errorResponse, followUpServerError, invalidFollowUpId, parseFollowUpId, readJsonBody,
} from '@/lib/follow-ups/route-responses'

// SP3: log a recall call/message (append-only). No patient notice.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!FOLLOW_UP_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = contactAttemptSchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'Invalid contact attempt')
  const id = parseFollowUpId((await params).id)
  if (id === null) return invalidFollowUpId()

  try {
    const result = await recordContactAttempt(id, parsed.data, session)
    if (!result.ok) {
      if (result.error === 'not_found') return errorResponse(404, FOLLOW_UP_NOT_FOUND)
      return errorResponse(409, FOLLOW_UP_CLOSED)
    }
    const a = result.attempt
    // Explicit projection: no user ids or other raw columns.
    const attempt: ContactAttemptView = { id: a.id, channel: a.channel, outcome: a.outcome, note: a.note, attemptedByName: a.attemptedByName, attemptedAt: a.attemptedAt }
    return NextResponse.json({ attempt }, { status: 201 })
  } catch (err) {
    return followUpServerError('contact attempt', err, 'Could not save the contact attempt')
  }
}
