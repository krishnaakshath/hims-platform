import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { createRate, getService, listRoomCategories } from '@/lib/queries/tariff'
import { getDepartmentById } from '@/lib/queries/departments'
import { getPayerById } from '@/lib/queries/payers'
import { rateCreateSchema } from '@/lib/tariff/validation'
import { pgErrorCode } from '@/lib/db-errors'
import { OVERLAP_MESSAGE, badRequest, conflict, forbidden, invalid, isRateOverlap, serverError } from '@/lib/tariff/route-responses'

// Add one effective-dated rate version. Amounts are integer paise (the schema rejects fractions).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body = json.body
  const parsed = rateCreateSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid rate')
  const input = parsed.data

  try {
    const service = await getService(input.serviceId)
    if (!service) return badRequest('Unknown service')
    if (input.departmentId !== undefined && !(await getDepartmentById(input.departmentId))) return badRequest('Unknown department')
    if (input.payerId !== undefined && !(await getPayerById(input.payerId))) return badRequest('Unknown payer')
    if (input.roomCategoryId !== undefined) {
      const categories = await listRoomCategories(true)
      if (!categories.some((c) => c.id === input.roomCategoryId)) return badRequest('Unknown room category')
    }

    const row = await createRate(input, session.name, { session, action: `tariff: added ${input.scope} rate for ${service.code}` })
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    if (isRateOverlap(err)) return conflict(OVERLAP_MESSAGE)
    // A referenced row vanished between the checks above and the insert.
    if (pgErrorCode(err) === '23503') return badRequest('Unknown service, department, payer or room category')
    return serverError('create rate', err, 'Could not add the rate')
  }
}
