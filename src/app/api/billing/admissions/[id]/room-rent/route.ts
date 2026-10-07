import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { roomRentPostSchema } from '@/lib/billing/validation'
import { postRoomRent } from '@/lib/queries/room-rent'
import { billingError, billingServerError, invalid, parseId, readJsonBody } from '@/lib/billing/route-responses'

// SP4: post room rent for every ended census day of an admission (idempotent; `{}` posts through today).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = roomRentPostSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid room-rent request')

  const id = parseId((await params).id)
  if (id === null) return billingError(400, 'Invalid admission id')

  try {
    const result = await postRoomRent(id, session, { throughDate: parsed.data.throughDate })
    if (!result.ok) {
      return result.error === 'not_found'
        ? billingError(404, 'Admission not found')
        : billingError(409, 'Set the room-rent service in Billing rules & settings first')
    }
    return NextResponse.json({ posted: result.posted, skipped: result.skipped })
  } catch (err) {
    return billingServerError('post room rent', err, 'Could not post room rent')
  }
}
