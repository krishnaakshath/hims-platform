import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { getInvoice } from '@/lib/queries/invoices'
import { InvoiceDocument } from '@/components/billing/InvoiceDocument'
import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'

// SP4: the A4 print view, outside the dashboard chrome. Every render is an audited read.
export default async function PrintInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) redirect('/')

  const { id: raw } = await params
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) notFound()
  const invoice = await getInvoice(Number(raw))
  if (!invoice) notFound()
  await logAudit(session, 'billing: printed invoice', invoice.patientId)

  return (
    <main className="min-h-screen bg-neutral-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center justify-between px-2 print:hidden">
        <BackLink href={`/billing/invoices/${invoice.id}`} label="Back to invoice" />
        <PrintButton />
      </div>
      <InvoiceDocument invoice={invoice} />
    </main>
  )
}
