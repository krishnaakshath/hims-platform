import { notFound } from 'next/navigation'
import { Download, Pill } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function MedicationRow({ name, medicationClass, dose, dateRange }: { name: string; medicationClass: string; dose: string | null; dateRange: string }) {
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
        <Pill className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{name} <span className="font-normal text-muted-foreground">({medicationClass})</span></p>
        <p className="text-xs text-muted-foreground">{dose ?? 'Dose not on file'} · {dateRange}</p>
      </div>
    </li>
  )
}

export default async function PatientPortalMedicationsPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

  await logPatientPortalAction('viewed patient portal medications', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Medications</h1>

      <section className={SECTION}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className={HEADING}>Current medications</h2>
          <a href="/api/patient-portal/medications-export" className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download summary
          </a>
        </div>
        {data.activeMedications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No current medications on file.</p>
        ) : (
          <ul className="space-y-2">
            {data.activeMedications.map((m) => (
              <MedicationRow key={m.id} name={m.name} medicationClass={m.medicationClass} dose={m.dose} dateRange={`Started ${m.startDate}`} />
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION}>
        <h2 className={HEADING}>Past medications</h2>
        {data.pastMedications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No past medications on file.</p>
        ) : (
          <ul className="space-y-2">
            {data.pastMedications.map((m) => (
              <MedicationRow key={m.id} name={m.name} medicationClass={m.medicationClass} dose={m.dose} dateRange={`${m.startDate} to ${m.stopDate ?? 'unknown'}`} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
