import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { getReceipt } from '@/lib/queries/patient-ledger'
import { getBillingSettings } from '@/lib/queries/billing-settings'
import { ReceiptDocument } from '@/components/billing/ReceiptDocument'
import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'

// SP4: an advance or payment receipt on A5-like width, outside the dashboard chrome. Audited.
export default async function ReceiptPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CASH_DESK_ROLES.includes(session.role)) redirect('/')

  const { id: raw } = await params
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) notFound()
  const receipt = await getReceipt(Number(raw))
  if (!receipt) notFound()
  const settings = await getBillingSettings()
  await logAudit(session, 'billing: printed receipt', receipt.patientId)

  return (
    <main className="min-h-screen bg-neutral-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[160mm] items-center justify-between px-2 print:hidden">
        <BackLink href={`/cash-desk?patientId=${encodeURIComponent(receipt.patientId)}`} label="Back to cash desk" />
        <PrintButton />
      </div>
      <ReceiptDocument receipt={receipt} settings={settings} />
    </main>
  )
}
