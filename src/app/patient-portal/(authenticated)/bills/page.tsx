// Wave J (P1-20): the signed-in patient's bills (finalised GST invoices) and receipts.
// Each opens the full document view, which re-checks ownership and audits the view.
import Link from 'next/link'
import { Receipt, FileText } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { listPortalInvoices, listPortalReceipts } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { PAYMENT_MODE_LABELS } from '@/components/billing/labels'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const ROW = 'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5'
const ICON = 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary'
const LINK = 'inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline'

export default async function PatientPortalBillsPage() {
  const session = await requirePatientSessionOrRedirect()
  const [bills, receipts] = await Promise.all([listPortalInvoices(session.patientId), listPortalReceipts(session.patientId)])
  await logPatientPortalAction('viewed patient portal bills', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Bills &amp; receipts</h1>

      <section className={SECTION} aria-labelledby="bills-heading">
        <h2 id="bills-heading" className={HEADING}>Bills</h2>
        {bills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills yet. A bill appears here once the hospital has issued it.</p>
        ) : (
          <ul className="space-y-2">
            {bills.map((b) => (
              <li key={b.id} className={ROW}>
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className={ICON} aria-hidden="true"><FileText className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{b.invoiceNumber}</p>
                    <p className="text-xs text-muted-foreground">{b.documentTitle ?? 'Tax invoice'} · {formatIsoDate(b.invoiceDate)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-semibold tabular-nums text-foreground">{formatPaise(b.totalPaise)}</span>
                  <Link href={`/patient-portal/documents/invoices/${b.id}`} className={LINK}>
                    View<span className="sr-only"> bill {b.invoiceNumber}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION} aria-labelledby="receipts-heading">
        <h2 id="receipts-heading" className={HEADING}>Receipts</h2>
        {receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {receipts.map((r) => (
              <li key={r.id} className={ROW}>
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className={ICON} aria-hidden="true"><Receipt className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{r.receiptNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.kind === 'advance' ? 'Advance' : 'Payment'} · {PAYMENT_MODE_LABELS[r.mode] ?? r.mode} · {formatIsoDate(r.receiptDate)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-semibold tabular-nums text-foreground">{formatPaise(r.amountPaise)}</span>
                  <Link href={`/patient-portal/documents/receipts/${r.id}`} className={LINK}>
                    View<span className="sr-only"> receipt {r.receiptNumber}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
