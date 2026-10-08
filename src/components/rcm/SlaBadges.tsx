import { SLA_FLAG_LABEL, type SlaFlag } from '@/lib/rcm/sla'

const OVERDUE = new Set<SlaFlag>(['submission_overdue', 'query_overdue', 'settlement_overdue', 'preauth_decision_overdue'])

export function SlaBadges({ flags }: { flags: SlaFlag[] }) {
  if (flags.length === 0) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${OVERDUE.has(f) ? 'bg-red-500/10 text-red-700' : 'bg-amber-500/10 text-amber-700'}`}>
          {SLA_FLAG_LABEL[f]}
        </span>
      ))}
    </span>
  )
}
