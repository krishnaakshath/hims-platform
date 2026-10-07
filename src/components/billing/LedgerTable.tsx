import Link from 'next/link'
import { formatPaise } from '@/lib/format'
import { formatDateTimeIn } from '@/lib/india-time'
import type { LedgerEntry } from '@/lib/billing/ledger'

const KIND_LABEL: Record<LedgerEntry['kind'], string> = {
  invoice: 'Invoice', credit_note: 'Credit note', advance: 'Advance', receipt: 'Payment', refund: 'Refund',
}
const DEBIT = new Set<LedgerEntry['kind']>(['invoice', 'refund'])

export function Balance({ paise }: { paise: number }) {
  return (
    <span className="tabular-nums">
      <span>{formatPaise(Math.abs(paise))}</span>
      {paise !== 0 && <span className="ml-1 text-xs text-muted-foreground">{paise > 0 ? 'due' : 'credit'}</span>}
    </span>
  )
}

/** SP4: the running patient ledger (IST times). Positive balance = the patient owes. */
export function LedgerTable({ rows }: { rows: (LedgerEntry & { balancePaise: number })[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No bills or payments yet.</p>
  const docHref = (r: LedgerEntry) =>
    r.kind === 'advance' || r.kind === 'receipt' ? `/print/receipts/${r.id}` : r.kind === 'invoice' ? `/billing/invoices/${r.id}` : null
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Date (IST)</th>
            <th className="px-3 py-2">Document</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2 text-right">Debit</th>
            <th className="px-3 py-2 text-right">Credit</th>
            <th className="px-3 py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = docHref(r)
            return (
              <tr key={`${r.kind}-${r.id}`} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-2">{formatDateTimeIn(r.at)}</td>
                <td className="px-3 py-2 font-medium">{href ? <Link href={href} className="text-primary hover:underline">{r.number}</Link> : r.number}</td>
                <td className="px-3 py-2">{KIND_LABEL[r.kind]}</td>
                <td className="px-3 py-2 text-right tabular-nums">{DEBIT.has(r.kind) ? formatPaise(r.amountPaise) : ''}</td>
                <td className="px-3 py-2 text-right tabular-nums">{DEBIT.has(r.kind) ? '' : formatPaise(r.amountPaise)}</td>
                <td className="px-3 py-2 text-right"><Balance paise={r.balancePaise} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
