import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { draftInvoiceSchema } from '@/lib/billing/validation'
import { createDraftInvoice } from '@/lib/queries/invoices'
import { billingServerError, invalid, invoiceErrorResponse, readJsonBody } from '@/lib/billing/route-responses'

// SP4: build a draft invoice from captured charge lines (no number until it is finalised).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = draftInvoiceSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Choose the charge lines to invoice')

  try {
    const result = await createDraftInvoice(parsed.data.lineIds, session)
    if (!result.ok) return invoiceErrorResponse(result.error)
    return NextResponse.json({ invoiceId: result.invoiceId }, { status: 201 })
  } catch (err) {
    return billingServerError('create draft invoice', err, 'Could not create the draft invoice')
  }
}
