import { Quote, FileText, CalendarDays } from 'lucide-react'
import { StatusChip } from './StatusChip'

const VERDICT_ACCENT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'border-l-success',
  yellow: 'border-l-warning',
  red: 'border-l-destructive',
}

export function EvidenceCard({ criterion }: { criterion: { criterionText: string; criterionType?: 'inclusion' | 'exclusion' | null; verdict: 'green' | 'yellow' | 'red'; evidenceQuote: string | null; evidenceSourceDoc: string | null; evidenceSourceDate: string | null } }) {
  return (
    <div className={`rounded-xl border border-l-4 border-border bg-card p-5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md ${VERDICT_ACCENT[criterion.verdict]}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <span className="text-sm font-semibold leading-snug text-foreground">{criterion.criterionText}</span>
        <span className="shrink-0"><StatusChip status={criterion.verdict} /></span>
      </div>
      {criterion.evidenceQuote ? (
        <blockquote className="flex gap-2 rounded-lg bg-secondary/60 p-3.5 text-sm leading-relaxed text-foreground">
          <Quote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{criterion.evidenceQuote}</span>
        </blockquote>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-3.5 text-sm text-muted-foreground">No evidence available — defaults to Needs Verification.</p>
      )}
      {(criterion.evidenceSourceDoc || criterion.evidenceSourceDate) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {criterion.evidenceSourceDoc && (
            <span className="inline-flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              {criterion.evidenceSourceDoc}
            </span>
          )}
          {criterion.evidenceSourceDate && (
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              {criterion.evidenceSourceDate}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
