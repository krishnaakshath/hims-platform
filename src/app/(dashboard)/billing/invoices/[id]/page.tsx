import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { BILLING_AUTHORITY_ROLES, CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import Link from 'next/link'
import { HandCoins } from 'lucide-react'
import { getInvoice, getInvoicePaidPaise } from '@/lib/queries/invoices'
import { invoiceOutstandingPaise } from '@/lib/billing/invoice-balance'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import { InvoiceDocument } from '@/components/billing/InvoiceDocument'
import { InvoiceActions } from '@/components/billing/InvoiceActions'
import { BackLink } from '@/components/BackLink'

// SP4: one invoice with its actions (finalise/cancel for BILLING_AUTHORITY_ROLES).
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) redirect('/')

  const { id: raw } = await params
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) notFound()
  const invoice = await getInvoice(Number(raw))
  if (!invoice) notFound()
  await logAudit(session, 'billing: viewed invoice', invoice.patientId)
  // Foundations T11: "Collect payment" opens the cash desk with what is still owed on this invoice.
  const paidPaise = invoice.status === 'finalised' ? await getInvoicePaidPaise(invoice.id) : 0
  const outstandingPaise = invoiceOutstandingPaise(invoice.status, invoice.totalPaise, paidPaise)
  const collectHref = outstandingPaise !== null && outstandingPaise > 0 && CASH_DESK_ROLES.includes(session.role)
    ? `/cash-desk?${new URLSearchParams({ patientId: invoice.patientId, amountPaise: String(outstandingPaise), invoiceId: String(invoice.id) })}`
    : null

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <BackLink href="/billing/invoices" label="All invoices" />
        <div className="flex flex-col items-end gap-2">
          <InvoiceActions invoiceId={invoice.id} status={invoice.status} canAuthorise={BILLING_AUTHORITY_ROLES.includes(session.role)} />
          {collectHref && (
            <div className="flex items-center gap-3 print:hidden">
              <span className="text-sm text-muted-foreground">Outstanding <span className="font-medium tabular-nums text-foreground">{formatPaise(outstandingPaise ?? 0)}</span></span>
              <Link href={collectHref} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                <HandCoins className="h-4 w-4" aria-hidden="true" />Collect payment
              </Link>
            </div>
          )}
        </div>
      </div>
      <InvoiceDocument invoice={invoice} />
    </div>
  )
}
