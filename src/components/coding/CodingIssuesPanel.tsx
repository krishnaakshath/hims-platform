// Coding checks from the pure rules (validateEncounterCoding at the finalise stage): errors first,
// then warnings, each linked to its diagnosis or procedure row. Errors block "Mark coded"/"Finalise".
import type { CodingIssue } from '@/lib/coding/rules'

export function entryAnchor(kind: 'diagnosis' | 'procedure', id: number): string {
  return `${kind}-${id}`
}

export function CodingIssuesPanel({ issues }: { issues: CodingIssue[] }) {
  const sorted = [...issues.filter((i) => i.severity === 'error'), ...issues.filter((i) => i.severity === 'warning')]
  const errors = sorted.filter((i) => i.severity === 'error').length
  return (
    <section aria-labelledby="coding-checks" className="space-y-2 rounded-lg border border-border p-4">
      <h2 id="coding-checks" className="text-base font-semibold">Coding checks</h2>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No problems found.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {errors > 0
              ? `${errors} ${errors === 1 ? 'error' : 'errors'} must be fixed before this visit can be marked coded or finalised.`
              : 'Only warnings: review them before finalising.'}
          </p>
          <ul className="space-y-1.5">
            {sorted.map((issue, i) => (
              <li key={`${issue.code}-${issue.entry?.kind ?? 'visit'}-${issue.entry?.id ?? 0}-${i}`} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className={`rounded px-1.5 text-[11px] font-semibold uppercase ${issue.severity === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100'}`}>
                  {issue.severity === 'error' ? 'Error' : 'Warning'}
                </span>
                <span>{issue.message}</span>
                {issue.entry && (
                  <a href={`#${entryAnchor(issue.entry.kind, issue.entry.id)}`} className="text-xs text-primary underline-offset-4 hover:underline">
                    {`Go to the ${issue.entry.kind}`}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
