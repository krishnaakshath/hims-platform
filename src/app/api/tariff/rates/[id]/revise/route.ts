import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { getRate, getService, reviseRate } from '@/lib/queries/tariff'
import { rateRevisionSchema } from '@/lib/tariff/validation'
import {
  OVERLAP_MESSAGE, REVISION_ERRORS, badRequest, conflict, forbidden, invalid, isRateOverlap, notFound, parseId, serverError,
} from '@/lib/tariff/route-responses'

// Close the current version the day before `effectiveFrom` and add the new amount, atomically.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const body = await request.json().catch(() => null)
  const parsed = rateRevisionSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid rate revision')

  const id = parseId((await params).id)
  if (id === null) return badRequest('Invalid rate id')

  try {
    const current = await getRate(id)
    if (!current) return notFound('Rate not found')
    const service = await getService(current.serviceId)
    if (!service) return notFound('Rate not found')

    const result = await reviseRate(id, parsed.data, session.name, {
      session, action: `tariff: revised rate #${id} for ${service.code} from ${parsed.data.effectiveFrom}`,
    })
    return NextResponse.json(result)
  } catch (err) {
    if (isRateOverlap(err)) return conflict(OVERLAP_MESSAGE)
    // planRevision's own plain-language refusals; any other message is never passed through.
    if (err instanceof Error && REVISION_ERRORS.includes(err.message)) return badRequest(err.message)
    if (err instanceof Error && err.message === 'Rate not found') return notFound('Rate not found')
    return serverError('revise rate', err, 'Could not revise the rate')
  }
}
