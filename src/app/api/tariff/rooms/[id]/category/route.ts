import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { listRoomCategories, setRoomCategory } from '@/lib/queries/tariff'
import { roomAssignmentSchema } from '@/lib/tariff/validation'
import { badRequest, forbidden, invalid, notFound, parseId, serverError } from '@/lib/tariff/route-responses'

// Assign a room/bed to a room category, or clear it with `{ roomCategoryId: null }`.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body = json.body
  const parsed = roomAssignmentSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid room category assignment')

  const roomId = parseId((await params).id)
  if (roomId === null) return badRequest('Invalid room id')
  const { roomCategoryId } = parsed.data

  try {
    if (roomCategoryId !== null) {
      const active = await listRoomCategories(false)
      if (!active.some((c) => c.id === roomCategoryId)) return badRequest('Unknown or inactive room category')
    }
    const updated = await setRoomCategory(roomId, roomCategoryId, { session, action: `tariff: set room category for room #${roomId}` })
    if (!updated) return notFound('Room not found')
    return NextResponse.json({ roomId, roomCategoryId })
  } catch (err) {
    return serverError('set room category', err, 'Could not set the room category')
  }
}
