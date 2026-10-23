// WS1 T4: the patient's problem list (listProblemList): diagnoses flagged onto it from any visit,
// plus legacy diagnoses recorded without a visit.
import { formatIsoDate } from '@/lib/india-time'

export interface ProblemListItem { id: number; label: string; code: string | null; since: string | null }

export function ProblemList({ items }: { items: ProblemListItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No problems on the list.</p>
  return (
    <ul className="divide-y divide-border text-sm" aria-label="Problem list">
      {items.map((p) => (
        <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
          {p.code && <span className="font-mono text-xs font-semibold">{p.code}</span>}
          <span className="flex-1 text-foreground">{p.label}</span>
          {p.since && <span className="text-xs text-muted-foreground">since {formatIsoDate(p.since)}</span>}
        </li>
      ))}
    </ul>
  )
}
