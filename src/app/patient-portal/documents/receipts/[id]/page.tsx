// Wave J (P1-20): the patient's own advance or payment receipt, the same ReceiptDocument
// the cash desk prints. Another patient's receipt is a 404. Every view is audited.
import { notFound } from 'next/navigation'
import { requirePortalDocumentSession } from '@/lib/patient-portal-documents'
import { parseId } from '@/lib/http'
import { getPortalReceipt } from '@/lib/queries/patient-portal-records'
import { getBillingSettings } from '@/lib/queries/billing-settings'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { ReceiptDocument } from '@/components/billing/ReceiptDocument'
import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'

export default async function PortalReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePortalDocumentSession()
  const id = parseId((await params).id)
  if (id === null) notFound()
  const receipt = await getPortalReceipt(session.patientId, id)
  if (!receipt) notFound()
  const { legalName, address, gstin } = await getBillingSettings()
  await logPatientPortalAction('viewed receipt via patient portal', session.patientId, `receipt=${receipt.id}`)

  return (
    <main className="min-h-screen bg-neutral-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[160mm] items-center justify-between px-2 print:hidden">
        <BackLink href="/patient-portal/bills" label="Back to bills" />
        <PrintButton />
      </div>
      <ReceiptDocument receipt={receipt} settings={{ legalName, address, gstin }} />
    </main>
  )
}
