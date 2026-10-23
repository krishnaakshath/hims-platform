import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { INVOICE_READY_ROLES } from '@/lib/role-policy'
import { billingError, billingServerError, readJsonBody } from '@/lib/billing/route-responses'
import { patientExists } from '@/lib/queries/auto-charge'
import { invoiceReadyLines, previewInvoiceReady } from '@/lib/queries/invoice-ready'

// WS2 T12: "Invoice all ready lines" (spec ruling 12). GET previews what would be drafted; POST
// drafts one invoice per ready group (drafts only; finalising stays a deliberate step). Optionally
// limited to one patient (the cash desk's "Invoice ready charges").
const PATIENT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
const scopeSchema = z.object({ patientId: PATIENT_ID.optional() }).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!INVOICE_READY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = scopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return billingError(400, 'Invalid request')
  const { patientId } = parsed.data

  try {
    if (patientId !== undefined && !(await patientExists(patientId))) return billingError(404, 'Patient not found')
    const preview = await previewInvoiceReady({ patientId })
    await logAudit(session, 'billing: previewed ready lines', patientId ?? null, `groups=${preview.groups} lines=${preview.lines} waiting=${preview.waitingLines}`)
    return NextResponse.json(preview)
  } catch (err) {
    return billingServerError('preview ready lines', err, 'Could not load the lines ready to invoice')
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!INVOICE_READY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = scopeSchema.safeParse(json.body)
  if (!parsed.success) return billingError(400, 'Invalid request')
  const { patientId } = parsed.data

  try {
    if (patientId !== undefined && !(await patientExists(patientId))) return billingError(404, 'Patient not found')
    // invoiceReadyLines writes the audit row (`billing: invoiced ready lines`, counts only).
    return NextResponse.json(await invoiceReadyLines(session, { patientId }))
  } catch (err) {
    return billingServerError('invoice ready lines', err, 'Could not create the draft invoices')
  }
}
