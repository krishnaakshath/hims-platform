import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { chargePreviewSchema } from '@/lib/billing/validation'
import { previewChargeLine } from '@/lib/queries/charge-capture'
import { billingServerError, captureErrorResponse, invalid, readJsonBody } from '@/lib/billing/route-responses'

// SP4: price and validate a charge without saving it. A preview never 422s: blocking rules travel
// in `preview.unresolved`.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = chargePreviewSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid charge')

  try {
    const result = await previewChargeLine(parsed.data, session)
    if (!result.ok) return captureErrorResponse(result.error)
    return NextResponse.json({ preview: result.preview })
  } catch (err) {
    return billingServerError('preview charge', err, 'Could not price the charge')
  }
}
