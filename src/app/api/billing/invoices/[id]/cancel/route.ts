import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BILLING_AUTHORITY_ROLES } from '@/lib/role-policy'
import { cancelInvoiceSchema } from '@/lib/billing/validation'
import { cancelInvoice } from '@/lib/queries/invoices'
import { billingError, billingServerError, invalid, invoiceErrorResponse, parseId, readJsonBody } from '@/lib/billing/route-responses'

// SP4: cancel a finalised invoice by issuing a full-value credit note (billing authority only).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_AUTHORITY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = cancelInvoiceSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Give a reason for cancelling (at least 5 characters)')

  const id = parseId((await params).id)
  if (id === null) return billingError(400, 'Invalid invoice id')

  try {
    const result = await cancelInvoice(id, parsed.data.reason, session)
    if (!result.ok) return invoiceErrorResponse(result.error)
    return NextResponse.json({ creditNoteNumber: result.creditNoteNumber })
  } catch (err) {
    return billingServerError('cancel invoice', err, 'Could not cancel the invoice')
  }
}
