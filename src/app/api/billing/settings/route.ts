import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BILLING_CONFIG_ROLES } from '@/lib/role-policy'
import { billingSettingsSchema } from '@/lib/billing/validation'
import { updateBillingSettings } from '@/lib/queries/billing-settings'
import { billingError, billingServerError, invalid, readJsonBody } from '@/lib/billing/route-responses'

// SP4: hospital billing settings (legal name, GSTIN, place of supply, rule thresholds). Admin only;
// billing sees them read-only, because the department being policed does not switch its own controls off.
export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_CONFIG_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = billingSettingsSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid billing settings')

  try {
    const result = await updateBillingSettings(parsed.data, session)
    if (!result.ok) return billingError(400, 'Choose a room-rent service from the Room rent category')
    return NextResponse.json({ ok: true })
  } catch (err) {
    return billingServerError('update settings', err, 'Could not save the billing settings')
  }
}
