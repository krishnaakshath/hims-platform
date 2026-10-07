import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { chargeCaptureSchema } from '@/lib/billing/validation'
import { captureChargeLine } from '@/lib/queries/charge-capture'
import { billingError, billingServerError, captureErrorResponse, invalid, readJsonBody } from '@/lib/billing/route-responses'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'

// SP4: capture one charge line against a visit or admission. Price override and rule overrides are
// field-level permissions checked by the query (BILLING_AUTHORITY_ROLES) after the body is parsed.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = chargeCaptureSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid charge')

  try {
    const result = await captureChargeLine(parsed.data, session)
    if (!result.ok) return captureErrorResponse(result.error, result.violations)
    return NextResponse.json({ line: result.line, violations: result.violations }, { status: 201 })
  } catch (err) {
    // The one FK the request names directly without a prior lookup.
    if (pgErrorCode(err) === '23503' && pgConstraint(err) === 'charge_lines_performing_provider_id_providers_id_fk') {
      return billingError(400, 'Performing doctor not found')
    }
    return billingServerError('capture charge', err, 'Could not add the charge')
  }
}
