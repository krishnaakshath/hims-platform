// SP5: booking context for one patient (id or UHID): contact, registered address, locality,
// bookable lab orders and booked visits. HOME_COLLECTION_BOOKING_ROLES; audited.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { HOME_COLLECTION_BOOKING_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getHomeCollectionContext } from '@/lib/queries/home-collections'
import { errorResponse, labServerError } from '@/lib/labs/route-responses'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!HOME_COLLECTION_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const patient = request.nextUrl.searchParams.get('patient')?.trim() ?? ''
  if (patient.length === 0 || patient.length > 40) return errorResponse(400, 'Enter a patient ID or UHID')

  try {
    const context = await getHomeCollectionContext(patient)
    if (!context) return errorResponse(404, 'Patient not found')
    await logAudit(session, 'viewed home collection booking context', context.patient.id)
    return NextResponse.json(context)
  } catch (err) {
    return labServerError('home collection context', err, 'Could not load the booking details')
  }
}
