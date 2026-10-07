import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { updateRoomCategory } from '@/lib/queries/tariff'
import { roomCategoryUpdateSchema } from '@/lib/tariff/validation'
import { badRequest, forbidden, invalid, notFound, parseId, serverError } from '@/lib/tariff/route-responses'

// `code` is immutable (rates reference the category by id, CSV imports by code).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const body = await request.json().catch(() => null)
  const parsed = roomCategoryUpdateSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid room category update')

  const id = parseId((await params).id)
  if (id === null) return badRequest('Invalid room category id')

  try {
    const verb = parsed.data.isActive === false ? 'deactivated' : 'updated'
    const row = await updateRoomCategory(id, parsed.data, { session, action: `tariff: ${verb} room category #${id}` })
    if (!row) return notFound('Room category not found')
    return NextResponse.json(row)
  } catch (err) {
    return serverError('update room category', err, 'Could not update room category')
  }
}
