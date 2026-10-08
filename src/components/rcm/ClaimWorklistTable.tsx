import Link from 'next/link'
import { formatPaise } from '@/lib/format'
import { CLAIM_STATUS_LABEL } from '@/lib/rcm/claim-status'
import type { ClaimListRow } from '@/lib/queries/rcm-worklist'
import { SlaBadges } from './SlaBadges'

export function ClaimWorklistTable({ rows }: { rows: ClaimListRow[] }) {
  if (rows.length === 0) return <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">No claims here.</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr><th className="px-3 py-2">Claim</th><th className="px-3 py-2">Patient</th><th className="px-3 py-2">Payer</th><th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Claimed</th><th className="px-3 py-2 text-right">Approved</th><th className="px-3 py-2 text-right">Outstanding</th><th className="px-3 py-2">Age</th><th className="px-3 py-2">SLA</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="px-3 py-2"><Link href={`/rcm/claims/${r.id}`} className="font-medium text-primary hover:underline">{r.claimNumber}</Link><div className="text-xs text-muted-foreground">{r.claimType.toUpperCase()}</div></td>
              <td className="px-3 py-2">{r.patient.name}<div className="text-xs text-muted-foreground">{r.patient.uhid ?? '—'}</div></td>
              <td className="px-3 py-2">{r.payerName}</td>
              <td className="px-3 py-2">{CLAIM_STATUS_LABEL[r.status]}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.claimedPaise)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.approvedPaise === null ? '—' : formatPaise(r.approvedPaise)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.insurerOutstandingPaise)}</td>
              <td className="px-3 py-2">{r.ageDays === null ? '—' : `${r.ageDays} d`}</td>
              <td className="px-3 py-2"><SlaBadges flags={r.slaFlags} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
