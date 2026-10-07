import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import { rupeesInWords } from '@/lib/billing/amount-words'
import { getReceipt } from '@/lib/queries/patient-ledger'
import { getBillingSettings } from '@/lib/queries/billing-settings'
import { PAYMENT_MODE_LABELS } from '@/components/billing/labels'
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

  const title = receipt.kind === 'advance' ? 'Advance Receipt' : 'Payment Receipt'
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[10rem_1fr] border-b border-neutral-200 py-2">
      <dt className="text-neutral-500 print:text-black">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )

  return (
    <main className="min-h-screen bg-neutral-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[160mm] items-center justify-between px-2 print:hidden">
        <BackLink href={`/cash-desk?patientId=${encodeURIComponent(receipt.patientId)}`} label="Back to cash desk" />
        <PrintButton />
      </div>
      <article className="mx-auto max-w-[160mm] bg-white p-8 text-[13px] text-neutral-900 shadow-sm ring-1 ring-neutral-200 print:max-w-none print:p-0 print:text-black print:shadow-none print:ring-0">
        <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-800 pb-4">
          <div>
            <p className="text-xl font-bold">{settings.legalName ?? 'Hospital legal name not set'}</p>
            {settings.address && <p className="whitespace-pre-line text-neutral-600 print:text-black">{settings.address}</p>}
            {settings.gstin && <p className="text-neutral-600 print:text-black">GSTIN {settings.gstin}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-lg font-bold tracking-wide">{title}</h1>
            <p className="font-semibold">{receipt.receiptNumber}</p>
            <p>{formatIsoDate(receipt.receiptDate)}</p>
          </div>
        </header>
        <dl className="mt-4">
          {row('Received from', <>{receipt.patientName}<span className="block text-xs font-normal text-neutral-500 print:text-black">UHID {receipt.uhid ?? '—'}</span></>)}
          {row('Amount', <span className="text-lg font-bold">{formatPaise(receipt.amountPaise)}</span>)}
          {row('In words', <span className="italic">{rupeesInWords(receipt.amountPaise)}</span>)}
          {row('Mode', PAYMENT_MODE_LABELS[receipt.mode] ?? receipt.mode)}
          {receipt.reference && row('Reference', receipt.reference)}
          {row('Towards', receipt.kind === 'advance' ? (receipt.admissionId !== null ? 'Advance deposit for the current admission' : 'Advance on account') : 'Payment of hospital bill')}
          {row('Received by', <>{receipt.receivedByName}<span className="block text-xs font-normal text-neutral-500 print:text-black">{formatDateTimeIn(receipt.receivedAt)} IST</span></>)}
        </dl>
        <footer className="mt-10 flex items-end justify-between text-xs text-neutral-500 print:text-black">
          <p>Computer-generated receipt.{receipt.kind === 'advance' ? ' Advances are adjusted against the final bill.' : ''}</p>
          <div className="text-right">
            <p>For {settings.legalName ?? 'the hospital'}</p>
            <p className="mt-8 border-t border-neutral-400 pt-1">Cashier</p>
          </div>
        </footer>
      </article>
    </main>
  )
}
