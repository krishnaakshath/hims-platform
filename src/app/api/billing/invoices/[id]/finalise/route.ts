import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BILLING_AUTHORITY_ROLES } from '@/lib/role-policy'
import { emptyBodySchema } from '@/lib/billing/validation'
import { finaliseInvoice } from '@/lib/queries/invoices'
import { billingError, billingServerError, invalid, invoiceErrorResponse, parseId, readJsonBody } from '@/lib/billing/route-responses'

// SP4: number, snapshot and total a draft invoice (billing authority only).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_AUTHORITY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = emptyBodySchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid request')

  const id = parseId((await params).id)
  if (id === null) return billingError(400, 'Invalid invoice id')

  try {
    const result = await finaliseInvoice(id, session)
    if (!result.ok) return invoiceErrorResponse(result.error)
    return NextResponse.json({ invoiceNumber: result.invoiceNumber })
  } catch (err) {
    return billingServerError('finalise invoice', err, 'Could not finalise the invoice')
  }
}
