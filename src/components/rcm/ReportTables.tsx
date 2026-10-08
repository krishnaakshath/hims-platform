import { formatPaise } from '@/lib/format'
import { AGING_BUCKETS } from '@/lib/rcm/sla'
import type { agingByPayer, denialAnalysis, payerPerformance } from '@/lib/queries/rcm-reports'

const table = 'w-full text-sm'
const head = 'bg-muted/50 text-left text-xs text-muted-foreground'
const wrap = 'overflow-x-auto rounded-lg border border-border bg-card'

export function AgingByPayerTable({ rows }: { rows: Awaited<ReturnType<typeof agingByPayer>> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nothing outstanding from insurers.</p>
  return (
    <div className={wrap}><table className={table}>
      <thead className={head}><tr><th className="px-3 py-2">Payer</th>{AGING_BUCKETS.map((b) => <th key={b.label} className="px-3 py-2 text-right">{b.label} days</th>)}<th className="px-3 py-2 text-right">Total</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.payerId} className="border-t border-border"><td className="px-3 py-2">{r.payerName}</td>{AGING_BUCKETS.map((b) => <td key={b.label} className="px-3 py-2 text-right tabular-nums">{formatPaise(r.buckets[b.label] ?? 0)}</td>)}<td className="px-3 py-2 text-right font-semibold tabular-nums">{formatPaise(r.totalPaise)}</td></tr>)}</tbody>
    </table></div>
  )
}

export function DenialAnalysisTable({ rows }: { rows: Awaited<ReturnType<typeof denialAnalysis>> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No deductions or rejections in this period.</p>
  return (
    <div className={wrap}><table className={table}>
      <thead className={head}><tr><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2 text-right">Claims</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Patient pays</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.reasonCode} className="border-t border-border"><td className="px-3 py-2">{r.label} <span className="text-xs text-muted-foreground">{r.reasonCode}</span></td><td className="px-3 py-2">{r.category.replace('_', ' ')}</td><td className="px-3 py-2 text-right">{r.claims}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.amountPaise)}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.patientRecoverablePaise)}</td></tr>)}</tbody>
    </table></div>
  )
}

export function PayerPerformanceTable({ rows }: { rows: Awaited<ReturnType<typeof payerPerformance>> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No claims submitted in this period.</p>
  return (
    <div className={wrap}><table className={table}>
      <thead className={head}><tr><th className="px-3 py-2">Payer</th><th className="px-3 py-2 text-right">Claims</th><th className="px-3 py-2 text-right">Claimed</th><th className="px-3 py-2 text-right">Approved</th><th className="px-3 py-2 text-right">Approval rate</th><th className="px-3 py-2 text-right">Settled</th><th className="px-3 py-2 text-right">TDS</th><th className="px-3 py-2 text-right">Deducted</th><th className="px-3 py-2 text-right">Written off</th><th className="px-3 py-2 text-right">Avg days to settle</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.payerId} className="border-t border-border"><td className="px-3 py-2">{r.payerName}</td><td className="px-3 py-2 text-right">{r.claims}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.claimedPaise)}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.approvedPaise)}</td><td className="px-3 py-2 text-right">{(r.approvalRateBp / 100).toFixed(2)}%</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.settledPaise)}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.tdsPaise)}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.disallowedPaise)}</td><td className="px-3 py-2 text-right tabular-nums">{formatPaise(r.writtenOffPaise)}</td><td className="px-3 py-2 text-right">{r.avgDaysToSettle ?? '—'}</td></tr>)}</tbody>
    </table></div>
  )
}
