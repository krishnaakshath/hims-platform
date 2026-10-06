'use client'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

export interface ClientFormRow {
  id: number
  patientName: string
  templateName: string
  diagnosisTag: string
  status: string
  sentDate: Date
  completedDate: Date | null
  totalScore: number | null
  bandLabel: string | null
}

// Whole-row navigation to the submitted answers, matching the row-click
// convention ReportTable.tsx already uses elsewhere in the app -- so both
// PI and coordinator sessions (this page carries no role restriction) can
// open any submission from here, not just by spotting the name link.
export function ClientFormsTable({ submissions }: { submissions: ClientFormRow[] }) {
  const router = useRouter()

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-left">
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Form</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Tag</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Completed</th>
            <th className="p-3" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {submissions.map((s, i) => (
            <tr
              key={s.id}
              onClick={() => router.push(`/client-forms/${s.id}`)}
              className={`cursor-pointer border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}
            >
              <td className="p-3 font-medium text-foreground">{s.patientName}</td>
              <td className="p-3 text-foreground">{s.templateName}</td>
              <td className="p-3 text-foreground">{s.diagnosisTag}</td>
              <td className="p-3 text-foreground capitalize">
                {s.status}
                {s.bandLabel !== null && <span className="normal-case"> · Score: {s.totalScore} ({s.bandLabel})</span>}
              </td>
              <td className="p-3 text-muted-foreground">{new Date(s.sentDate).toLocaleDateString()}</td>
              <td className="p-3 text-muted-foreground">{s.completedDate ? new Date(s.completedDate).toLocaleDateString() : '—'}</td>
              <td className="p-3 text-muted-foreground"><ChevronRight className="h-4 w-4" aria-hidden="true" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
