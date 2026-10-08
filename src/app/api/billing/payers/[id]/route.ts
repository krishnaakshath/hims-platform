import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BILLING_CONFIG_ROLES } from '@/lib/role-policy'
import { payerBillingFlagsSchema } from '@/lib/billing/validation'
import { updatePayerBillingFlags } from '@/lib/queries/billing-settings'
import { billingError, billingServerError, invalid, parseId, readJsonBody } from '@/lib/billing/route-responses'

// SP4: a payer's billing flags (pre-authorisation, GSTIN, state for the place of supply).
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_CONFIG_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = payerBillingFlagsSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid payer billing details')

  const id = parseId((await params).id)
  if (id === null) return billingError(400, 'Invalid payer id')

  try {
    if (!(await updatePayerBillingFlags(id, parsed.data, session))) return billingError(404, 'Payer not found')
    return NextResponse.json({ ok: true })
  } catch (err) {
    return billingServerError('update payer flags', err, 'Could not save the payer')
  }
}
