// SP6 Task 13: "Coding queries for you" on /doctor -- the signed-in doctor's open coding queries,
// oldest first, each linking to the patient's chart at the Visit coding section where the reply
// box is. Hidden when there are none. Dates use the fixed-zone IST formatters.
import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import type { ProviderCodingQuery } from '@/lib/queries/coding-queries'

export function DoctorCodingQueries({ queries }: { queries: ProviderCodingQuery[] }) {
  if (queries.length === 0) return null
  return (
    <section aria-labelledby="doctor-coding-queries" className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileQuestion className="h-4 w-4 text-warning" aria-hidden="true" />
          <h3 id="doctor-coding-queries" className="text-sm font-semibold text-foreground">Coding queries for you</h3>
        </div>
        <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-bold text-warning-foreground">{queries.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {queries.map((q) => (
          <li key={q.queryId} className="flex flex-col gap-1.5 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <Link href={`/patients/${q.patientId}/medical-record#visit-coding`} className="font-semibold text-primary hover:underline">
                {q.patientName}
              </Link>
              <span className="text-xs text-muted-foreground">{`Visit ${formatIsoDate(q.encounterDate)}`}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground">{q.question}</p>
            <p className="text-xs text-muted-foreground">{`From ${q.raisedByName} · ${formatDateTimeIn(q.raisedAt)}`}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
