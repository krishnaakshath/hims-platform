import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_LOOKUP_ROLES, TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { createRoomCategory, listRoomCategories } from '@/lib/queries/tariff'
import { roomCategoryCreateSchema } from '@/lib/tariff/validation'
import { isUniqueViolation } from '@/lib/db-errors'
import { conflict, forbidden, invalid, serverError } from '@/lib/tariff/route-responses'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_LOOKUP_ROLES.includes(session.role)) return forbidden()

  const flag = request.nextUrl.searchParams.get('includeInactive')
  const includeInactive = (flag === '1' || flag === 'true') && TARIFF_MANAGE_ROLES.includes(session.role)
  try {
    return NextResponse.json({ roomCategories: await listRoomCategories(includeInactive) })
  } catch (err) {
    return serverError('list room categories', err, 'Could not load room categories')
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const body = await request.json().catch(() => null)
  const parsed = roomCategoryCreateSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid room category')

  try {
    const row = await createRoomCategory(parsed.data, { session, action: `tariff: created room category ${parsed.data.code}` })
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err, 'room_categories_code_unique')) return conflict('Room category code already exists')
    return serverError('create room category', err, 'Could not create room category')
  }
}
