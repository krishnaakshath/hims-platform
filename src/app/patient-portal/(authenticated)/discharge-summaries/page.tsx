// Wave J (P1-20): the signed-in patient's discharge summaries. A summary opens only once
// the consultant has signed it; until then the stay is listed as being prepared.
import Link from 'next/link'
import { BedDouble } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { listPortalDischarges } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { formatIstDate } from '@/lib/india-time'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

export default async function PatientPortalDischargeSummariesPage() {
  const session = await requirePatientSessionOrRedirect()
  const stays = await listPortalDischarges(session.patientId)
  await logPatientPortalAction('viewed patient portal discharge summaries', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Discharge summaries</h1>
      <section className={SECTION}>
        {stays.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hospital stays on file.</p>
        ) : (
          <ul className="space-y-2">
            {stays.map((s) => (
              <li key={s.admissionId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                    <BedDouble className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{formatIstDate(s.admittedAt)} – {formatIstDate(s.dischargedAt)}</p>
                    <p className="text-xs text-muted-foreground">Under {s.doctorName}</p>
                  </div>
                </div>
                {s.signed ? (
                  <Link href={`/patient-portal/documents/discharge/${s.admissionId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
                    View summary<span className="sr-only"> for the stay discharged {formatIstDate(s.dischargedAt)}</span>
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">Being prepared by your doctor</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
