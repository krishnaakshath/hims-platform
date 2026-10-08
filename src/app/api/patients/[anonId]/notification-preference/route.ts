import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { NOTIFICATION_PREFERENCE_ROLES } from '@/lib/role-policy'
import { notificationPreferenceSchema } from '@/lib/labs/validation'
import { setNotificationOptOut } from '@/lib/queries/notifications'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { errorResponse, labServerError, readJsonBody } from '@/lib/labs/route-responses'

// SP5: a patient's notification opt-out (lab and home-collection notices), set by staff.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NOTIFICATION_PREFERENCE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = notificationPreferenceSchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'Invalid notification preference')
  const { anonId } = await params

  const { optOut } = parsed.data
  try {
    const found = await setNotificationOptOut(anonId, optOut, session)
    if (!found) return errorResponse(404, 'Patient not found')
  } catch (err) {
    return labServerError('notification preference', err, 'Could not save the notification preference')
  }

  try {
    // The patient detail read model (with the flag) is cached; drop it so the change shows.
    await invalidateCache(patientDetailCacheKey(anonId))
  } catch (err) {
    console.error(`[notify] cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return NextResponse.json({ optOut })
}
