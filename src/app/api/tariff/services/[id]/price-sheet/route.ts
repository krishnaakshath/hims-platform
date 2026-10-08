// Wave G P1-05: GET /api/tariff/services/[id]/price-sheet?onDate=YYYY-MM-DD -- the rate card the
// price lookup shows once a service is picked: every rate in force on the date, by scope (base,
// department, payer) and room category / ward, in INR. Same gate and audit rule as
// /api/tariff/resolve (TARIFF_LOOKUP_ROLES; no PHI, not audited). Inactive services are a
// catalogue-management concern, so a lookup role gets 404 for them as for an unknown id.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'
import { getService, listRatesForService, listRoomCategories } from '@/lib/queries/tariff'
import { isoDate } from '@/lib/tariff/validation'
import { buildPriceSheet } from '@/lib/tariff/price-sheet'
import { todayIsoIn } from '@/lib/india-time'
import { badRequest, forbidden, notFound, parseId, serverError } from '@/lib/tariff/route-responses'

const querySchema = z.object({ onDate: isoDate.optional() }).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_LOOKUP_ROLES.includes(session.role)) return forbidden()

  const id = parseId((await params).id)
  if (id === null) return badRequest('Invalid service id')
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return badRequest('Invalid price lookup')
  const onDate = parsed.data.onDate ?? todayIsoIn('Asia/Kolkata')

  try {
    const service = await getService(id)
    if (!service || !service.isActive) return notFound('Service not found')
    const [rates, categories] = await Promise.all([listRatesForService(id), listRoomCategories(true)])
    const sheet = buildPriceSheet(rates, onDate, categories)
    // Fields listed explicitly so nothing added to the service row later leaks by default.
    return NextResponse.json({
      service: {
        id: service.id, code: service.code, name: service.name, category: service.category,
        departmentId: service.departmentId, departmentName: service.departmentName,
        gstRateBp: service.gstRateBp, hsnSac: service.hsnSac,
      },
      onDate,
      ...sheet,
    })
  } catch (err) {
    return serverError('price sheet', err, 'Could not load the price list')
  }
}
