// GET /api/tariff/resolve: the single price-lookup entry point (SP4 charge capture will call it).
// Lookups carry no PHI and are high-volume, so they are not audited (plan ruling 8). The query
// schema is strict: any parameter outside the lookup fields (e.g. a patient id) is a 400.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'
import { getServiceByCode, loadPricingContext } from '@/lib/queries/tariff'
import { resolvePrice } from '@/lib/tariff/resolve'
import { resolveQuerySchema } from '@/lib/tariff/validation'
import { todayIsoIn } from '@/lib/india-time'
import { formatPaise } from '@/lib/money'
import { badRequest, forbidden, parseId, serverError } from '@/lib/tariff/route-responses'

const INVALID = 'Invalid price lookup'
const ID_PARAMS = ['serviceId', 'payerId', 'departmentId'] as const

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_LOOKUP_ROLES.includes(session.role)) return forbidden()

  const params = request.nextUrl.searchParams
  const keys = [...params.keys()]
  if (new Set(keys).size !== keys.length) return badRequest(INVALID) // a repeated parameter is ambiguous
  const raw = Object.fromEntries(params)
  // Ids must be plain positive int4 digits: z.coerce alone would accept '1e3', '0x10' or values
  // beyond the int4 column range (which would surface as a DB error).
  for (const k of ID_PARAMS) {
    if (raw[k] !== undefined && parseId(raw[k]) === null) return badRequest(INVALID)
  }
  const parsed = resolveQuerySchema.safeParse(raw)
  if (!parsed.success) return badRequest(INVALID)
  const q = parsed.data
  const onDate = q.onDate ?? todayIsoIn('Asia/Kolkata')

  try {
    let serviceId = q.serviceId
    if (serviceId === undefined) {
      const service = await getServiceByCode(q.serviceCode!.toUpperCase())
      if (!service) return NextResponse.json({ ok: false, reason: 'service_not_found' })
      serviceId = service.id
    }
    const ctx = await loadPricingContext(serviceId)
    const r = resolvePrice(
      { serviceId, payerId: q.payerId, departmentId: q.departmentId, roomCategory: q.roomCategory, ward: q.ward, onDate },
      ctx,
    )
    if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason })
    // Fields are listed explicitly so nothing added to PriceResolution later leaks by default.
    return NextResponse.json({
      ok: true, serviceId: r.serviceId, serviceCode: r.serviceCode, serviceName: r.serviceName,
      amountPaise: r.amountPaise, currency: r.currency, gstRateBp: r.gstRateBp, hsnSac: r.hsnSac,
      rateId: r.rateId, scope: r.scope, matched: { roomCategory: r.matched.roomCategory, ward: r.matched.ward },
      formatted: formatPaise(r.amountPaise),
    })
  } catch (err) {
    return serverError('resolve price', err, 'Could not look up the price')
  }
}
