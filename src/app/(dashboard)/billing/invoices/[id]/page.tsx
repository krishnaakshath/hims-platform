import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { BILLING_AUTHORITY_ROLES, CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { getInvoice } from '@/lib/queries/invoices'
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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <BackLink href="/billing/invoices" label="All invoices" />
        <InvoiceActions invoiceId={invoice.id} status={invoice.status} canAuthorise={BILLING_AUTHORITY_ROLES.includes(session.role)} />
      </div>
      <InvoiceDocument invoice={invoice} />
    </div>
  )
}
