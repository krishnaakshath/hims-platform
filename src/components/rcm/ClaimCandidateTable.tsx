import Link from 'next/link'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import type { ClaimCandidate } from '@/lib/queries/rcm-worklist'
import { SlaBadges } from './SlaBadges'

export function ClaimCandidateTable({ rows }: { rows: ClaimCandidate[] }) {
  if (rows.length === 0) return <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">Every finalised insurer bill is on a claim.</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr><th className="px-3 py-2">Patient</th><th className="px-3 py-2">Visit or stay</th><th className="px-3 py-2">Payer</th><th className="px-3 py-2 text-right">Bills</th><th className="px-3 py-2 text-right">To claim</th><th className="px-3 py-2">Ended</th><th className="px-3 py-2">SLA</th><th className="px-3 py-2" /></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ref = r.admissionId !== null ? `admissionId=${r.admissionId}` : `encounterId=${r.encounterId}`
            return (
              <tr key={`${r.patient.id}-${ref}-${r.policyId}`} className="border-t border-border">
                <td className="px-3 py-2">{r.patient.name}<div className="text-xs text-muted-foreground">{r.patient.uhid ?? '—'}</div></td>
                <td className="px-3 py-2">{r.admissionId !== null ? `Admission ${r.admissionId}` : `Visit ${r.encounterId}`}</td>
                <td className="px-3 py-2">{r.payerName}</td>
                <td className="px-3 py-2 text-right">{r.invoiceCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.availablePaise)}</td>
                <td className="px-3 py-2">{r.episodeEndDate ? formatIsoDate(r.episodeEndDate) : 'Ongoing'}</td>
                <td className="px-3 py-2"><SlaBadges flags={r.slaFlags} /></td>
                <td className="px-3 py-2 text-right"><Link href={`/rcm/claims/new?${ref}&policyId=${r.policyId}`} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">Start claim</Link></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
