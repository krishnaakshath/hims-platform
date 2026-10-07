import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { deactivateRate, endRate, getRate, listRatesForService, toDatedRate } from '@/lib/queries/tariff'
import { findOverlap } from '@/lib/tariff/versions'
import { ratePatchSchema } from '@/lib/tariff/validation'
import { pgErrorCode } from '@/lib/db-errors'
import {
  OVERLAP_MESSAGE, badRequest, conflict, forbidden, invalid, isRateOverlap, notFound, parseId, serverError,
} from '@/lib/tariff/route-responses'

// `{ validTo }` ends (or re-ends) a version; `{ deactivate: true }` withdraws it from pricing.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const body = await request.json().catch(() => null)
  const parsed = ratePatchSchema.safeParse(body)
  if (!parsed.success) return invalid(parsed.error, 'Send either { validTo } or { deactivate: true }')

  const id = parseId((await params).id)
  if (id === null) return badRequest('Invalid rate id')
  const patch = parsed.data

  try {
    const current = await getRate(id)
    if (!current) return notFound('Rate not found')

    if ('deactivate' in patch) {
      const row = await deactivateRate(id, { session, action: `tariff: deactivated rate #${id}` })
      return row ? NextResponse.json(row) : notFound('Rate not found')
    }

    if (current.deactivatedAt !== null) return badRequest('The rate is deactivated')
    if (patch.validTo < current.validFrom) return badRequest('Valid-to cannot be before valid-from')
    // App-level check (the DB exclusion is the backstop): moving the end later can run into the next version.
    const others = (await listRatesForService(current.serviceId)).map(toDatedRate)
    if (findOverlap({ ...toDatedRate(current), validTo: patch.validTo }, others)) return conflict(OVERLAP_MESSAGE)

    const row = await endRate(id, patch.validTo, { session, action: `tariff: ended rate #${id}` })
    return row ? NextResponse.json(row) : notFound('Rate not found')
  } catch (err) {
    if (isRateOverlap(err)) return conflict(OVERLAP_MESSAGE)
    if (pgErrorCode(err) === '23514') return badRequest('Valid-to cannot be before valid-from')
    return serverError('update rate', err, 'Could not update the rate')
  }
}
