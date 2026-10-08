// SP5: the signed-in patient's released lab reports (current versions only). Downloads go
// through the owner-checked, audited portal route.
import { Download, FileCheck } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { listPortalLabReports } from '@/lib/queries/lab-reports'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { formatDateTimeIn } from '@/lib/india-time'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

export default async function PatientPortalLabReportsPage() {
  const session = await requirePatientSessionOrRedirect()
  const reports = await listPortalLabReports(session.patientId)
  await logPatientPortalAction('viewed patient portal lab reports', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Your lab reports</h1>
      <section className={SECTION}>
        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lab reports yet. Reports appear here once your doctor has verified the results.</p>
        ) : (
          <ul className="space-y-2">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                    <FileCheck className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{r.testSummary}</p>
                    <p className="text-xs text-muted-foreground">Released {formatDateTimeIn(new Date(r.releasedAt))}</p>
                    <p className="text-xs text-muted-foreground">Report {r.reportNumber}</p>
                  </div>
                </div>
                <a href={`/api/patient-portal/lab-reports/${r.id}/download`} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download<span className="sr-only"> report {r.reportNumber}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
