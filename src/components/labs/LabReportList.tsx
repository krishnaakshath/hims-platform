// SP5: the chart's released lab reports (every version; superseded ones marked). Downloads go
// through the audited staff route; the stored file's address never reaches the browser.
import { FileText } from 'lucide-react'
import { formatDateTimeIn } from '@/lib/india-time'

export interface LabReportListItem {
  id: number
  reportNumber: string
  version: number
  releasedAt: Date
  testSummary: string
  supersededAt: Date | null
}

export function LabReportList({ reports }: { reports: LabReportListItem[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lab reports</h3>
      {reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">No lab reports released yet.</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm ${r.supersededAt ? 'opacity-70' : 'bg-secondary/30'}`}>
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  Report {r.reportNumber}{r.version > 1 ? ` (version ${r.version})` : ''}
                  {r.supersededAt && <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Superseded</span>}
                </p>
                <p className="text-xs text-muted-foreground">{r.testSummary} · Released {formatDateTimeIn(new Date(r.releasedAt))}</p>
              </div>
              <a href={`/api/lab-reports/${r.id}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                Download PDF<span className="sr-only"> of report {r.reportNumber}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
