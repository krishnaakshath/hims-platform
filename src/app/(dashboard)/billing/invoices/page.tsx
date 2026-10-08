import Link from 'next/link'
import { redirect } from 'next/navigation'
import { FileText } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { INVOICE_PAGE_SIZE, listInvoices, type InvoiceStatus } from '@/lib/queries/invoices'
import { INVOICE_STATUS_LABELS } from '@/components/billing/labels'
import { FIELD_CLASS } from '@/components/tariff/api'

const STATUSES: InvoiceStatus[] = ['draft', 'finalised', 'cancelled', 'discarded']
const STATUS_CLASS: Record<InvoiceStatus, string> = {
  draft: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  finalised: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  discarded: 'bg-muted text-muted-foreground',
}

// SP4: invoices, newest first (CHARGE_CAPTURE_ROLES = BILLING_ROLES).
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const status = STATUSES.find((s) => s === sp.status)
  const q = typeof sp.q === 'string' && sp.q.trim() ? sp.q.trim().slice(0, 40) : undefined
  const page = typeof sp.page === 'string' && /^[1-9]\d{0,5}$/.test(sp.page) ? Number(sp.page) : 1
  const { rows, total } = await listInvoices({ status, q, page })
  const first = total === 0 ? 0 : (page - 1) * INVOICE_PAGE_SIZE + 1
  const last = Math.min(total, page * INVOICE_PAGE_SIZE)
  const href = (p: number) => `/billing/invoices?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}), page: String(p) })}`

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><FileText className="h-5 w-5" /></span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Invoices</h1>
          <p className="text-sm text-muted-foreground">Drafts, finalised GST invoices and cancellations. Build a draft from the charge capture screen.</p>
        </div>
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="inv-q" className="mb-1 block text-xs font-medium text-muted-foreground">Invoice number or UHID</label>
          <input id="inv-q" name="q" defaultValue={q ?? ''} placeholder="INV/26-27/ or UHID" className={`${FIELD_CLASS} w-64`} />
        </div>
        <div>
          <label htmlFor="inv-status" className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
          <select id="inv-status" name="status" defaultValue={status ?? ''} className={`${FIELD_CLASS} w-40`}>
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</option>)}
          </select>
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Filter</button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No invoices match.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Payer</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium"><Link href={`/billing/invoices/${r.id}`} className="text-primary hover:underline">{r.invoiceNumber ?? `Draft #${r.id}`}</Link></td>
                  <td className="whitespace-nowrap px-3 py-2">{r.invoiceDate ? formatIsoDate(r.invoiceDate) : '—'}</td>
                  <td className="px-3 py-2">{r.patientName}<span className="block text-xs text-muted-foreground">{r.uhid ?? r.patientId}</span></td>
                  <td className="px-3 py-2">{r.payerName ?? 'Self-pay'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.totalPaise === null ? '—' : formatPaise(r.totalPaise)}</td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[r.status]}`}>{INVOICE_STATUS_LABELS[r.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>{`Showing ${first}–${last} of ${total}`}</span>
        <span className="flex gap-3">
          {page > 1 && <Link href={href(page - 1)} className="hover:text-foreground">Previous</Link>}
          {last < total && <Link href={href(page + 1)} className="hover:text-foreground">Next</Link>}
        </span>
      </div>
    </div>
  )
}
