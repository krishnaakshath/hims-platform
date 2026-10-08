// Wave J (P1-20): prescriptions written for the signed-in patient in this hospital, with the
// prescriber, dose, frequency and duration. Imported medication history stays on Medications.
import { Pill } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { listPortalPrescriptions, type PortalPrescription } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { formatIsoDate, formatIstDate } from '@/lib/india-time'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function schedule(p: PortalPrescription): string {
  const parts = [p.dose, p.frequencyPerDay ? `${p.frequencyPerDay} time${p.frequencyPerDay === 1 ? '' : 's'} a day` : null, p.durationDays ? `for ${p.durationDays} day${p.durationDays === 1 ? '' : 's'}` : null]
  return parts.filter(Boolean).join(' · ') || 'As directed'
}

function PrescriptionList({ rows }: { rows: PortalPrescription[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((p) => (
        <li key={p.id} className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <Pill className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{p.name}</p>
            <p className="text-xs text-muted-foreground">{schedule(p)}</p>
            {p.instructions && <p className="text-xs text-foreground">{p.instructions}</p>}
            <p className="text-xs text-muted-foreground">
              Prescribed {formatIstDate(p.prescribedAt)}{p.prescriberName ? ` by ${p.prescriberName}` : ''}
              {p.stopDate ? ` · until ${formatIsoDate(p.stopDate)}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default async function PatientPortalPrescriptionsPage() {
  const session = await requirePatientSessionOrRedirect()
  const rows = await listPortalPrescriptions(session.patientId)
  await logPatientPortalAction('viewed patient portal prescriptions', session.patientId)
  const current = rows.filter((r) => r.status === 'active')
  const past = rows.filter((r) => r.status !== 'active')

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Prescriptions</h1>
      <section className={SECTION} aria-labelledby="rx-current">
        <h2 id="rx-current" className={HEADING}>Current</h2>
        {current.length === 0 ? <p className="text-sm text-muted-foreground">No current prescriptions.</p> : <PrescriptionList rows={current} />}
      </section>
      <section className={SECTION} aria-labelledby="rx-past">
        <h2 id="rx-past" className={HEADING}>Past</h2>
        {past.length === 0 ? <p className="text-sm text-muted-foreground">No past prescriptions.</p> : <PrescriptionList rows={past} />}
      </section>
      <p className="text-xs text-muted-foreground">Take medicines only as your doctor advised. For a printed prescription, ask at the pharmacy or the front desk.</p>
    </div>
  )
}
