// Wave J (P1-20): the patient's own finalised GST invoice, the same InvoiceDocument the
// billing desk prints. Outside the portal chrome so it prints on A4. Another patient's
// invoice, a draft or a cancelled one is a 404 (never a 403). Every view is audited.
import { notFound } from 'next/navigation'
import { requirePortalDocumentSession } from '@/lib/patient-portal-documents'
import { parseId } from '@/lib/http'
import { getPortalInvoice } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { InvoiceDocument } from '@/components/billing/InvoiceDocument'
import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'

export default async function PortalInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePortalDocumentSession()
  const id = parseId((await params).id)
  if (id === null) notFound()
  const invoice = await getPortalInvoice(session.patientId, id)
  if (!invoice) notFound()
  await logPatientPortalAction('viewed invoice via patient portal', session.patientId, `invoice=${invoice.id}`)

  return (
    <main className="min-h-screen bg-neutral-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center justify-between px-2 print:hidden">
        <BackLink href="/patient-portal/bills" label="Back to bills" />
        <PrintButton />
      </div>
      <InvoiceDocument invoice={invoice} />
    </main>
  )
}
