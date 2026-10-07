// SP5: collection-window availability for one IST date. HOME_COLLECTION_BOOKING_ROLES.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { HOME_COLLECTION_BOOKING_ROLES } from '@/lib/role-policy'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { listWindowAvailability } from '@/lib/queries/home-collections'
import { errorResponse, labServerError } from '@/lib/labs/route-responses'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!HOME_COLLECTION_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const date = isoDateSchema.safeParse(request.nextUrl.searchParams.get('date') ?? '')
  if (!date.success) return errorResponse(400, 'Enter a valid date (YYYY-MM-DD)')

  try {
    return NextResponse.json(await listWindowAvailability(date.data))
  } catch (err) {
    return labServerError('home collection availability', err, 'Could not load the collection windows')
  }
}
