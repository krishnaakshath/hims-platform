import { AlertTriangle, BedDouble } from 'lucide-react'
import type { WorkspaceView } from '@/lib/queries/encounter-workspace'
import { ENCOUNTER_STATUS_LABEL, ENCOUNTER_TYPE_LABEL, VISIT_TYPE_LABEL, genderLabel } from '@/lib/encounters/register'
import { formatPhoneForDisplay } from '@/lib/patient-directory'
import { formatIsoDate } from '@/lib/india-time'
import { formatPaise } from '@/lib/money'
import { AllergyEditor } from './AllergyEditor'
import { StartEncounterButton } from './StartEncounterButton'

const ALERT_TEXT: Record<WorkspaceView['patient']['alerts'][number], string> = {
  allergy_status_unknown: 'Allergy status not recorded',
  currently_admitted: 'Currently admitted',
}

// WS1 T3: who the patient is and which visit this is, always on top of the workspace. Shows the
// UHID, never the chart id. "Start consultation" appears only on a checked-in visit the viewer may
// write; it POSTs (the page itself never starts a visit).
export function PatientStrip({ view, canEditAllergies, visitCharges }: {
  view: Pick<WorkspaceView, 'encounter' | 'patient' | 'canWrite'>; canEditAllergies: boolean
  /** WS2 T14: the visit's live charge lines (GST-inclusive estimate). */
  visitCharges?: { totalPaise: number; lines: number }
}) {
  const { encounter: e, patient: p } = view
  const ageSex = [p.ageYears !== null ? `${p.ageYears} y` : null, p.sex ? genderLabel(p.sex) : null].filter(Boolean).join(' / ')
  return (
    <section aria-label="Patient" className="sticky top-0 z-10 flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-foreground">{p.name}</h1>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{p.uhid ?? 'No UHID'}</span>
            {ageSex && <><span aria-hidden="true">·</span><span>{ageSex}</span></>}
            {p.phone && <><span aria-hidden="true">·</span><span>{formatPhoneForDisplay(p.phone)}</span></>}
            <span aria-hidden="true">·</span><span>{p.payerName ?? 'Self-pay'}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right text-sm">
          <p className="font-semibold text-foreground">
            {ENCOUNTER_TYPE_LABEL[e.encounterType]}{e.opdToken !== null ? ` · Token #${e.opdToken}` : ''} · {VISIT_TYPE_LABEL[e.visitType]}
          </p>
          <p className="text-muted-foreground">{[e.departmentName, e.providerName, formatIsoDate(e.encounterDate)].filter(Boolean).join(' · ')}</p>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">{ENCOUNTER_STATUS_LABEL[e.status]}</p>
          {visitCharges && (
            <p className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground">
              {`Visit charges ${formatPaise(visitCharges.totalPaise)} (${visitCharges.lines} ${visitCharges.lines === 1 ? 'line' : 'lines'})`}
            </p>
          )}
          {e.status === 'checked_in' && view.canWrite && <StartEncounterButton encounterId={e.id} label="Start consultation" />}
        </div>
      </div>
      {p.alerts.length > 0 && (
        <ul aria-label="Alerts" className="flex flex-wrap gap-2">
          {p.alerts.map((a) => (
            <li key={a} className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-semibold text-warning-foreground">
              {a === 'currently_admitted' ? <BedDouble className="h-3.5 w-3.5" aria-hidden="true" /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
              {ALERT_TEXT[a]}
            </li>
          ))}
        </ul>
      )}
      <AllergyEditor patientId={p.id} allergyStatus={p.allergyStatus} allergies={p.allergies} canEdit={canEditAllergies} />
    </section>
  )
}
