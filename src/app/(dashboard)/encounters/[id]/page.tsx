import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ALLERGY_WRITE_ROLES, WORKSPACE_READ_ROLES } from '@/lib/role-policy'
import { parseEncounterId } from '@/lib/encounters/ownership'
import { getWorkspace, patientDiagnosisCodes } from '@/lib/queries/encounter-workspace'
import { listMedicationsWithInventory } from '@/lib/queries/medications'
import { listAllProviders } from '@/lib/queries/providers'
import { listLabTests } from '@/lib/queries/lab-tests'
import { resolveSessionProvider } from '@/lib/provider-identity'
import { formatIsoDate, formatIstDateTime } from '@/lib/india-time'
import { PatientStrip } from '@/components/encounters/PatientStrip'
import { WorkspaceShell, WorkspaceOrdersLauncher, WorkspaceRxLauncher } from '@/components/encounters/WorkspaceShell'
import { VitalsForm } from '@/components/encounters/VitalsForm'
import { ConsultForm } from '@/components/encounters/ConsultForm'
import { NoteForm } from '@/components/NoteForm'

const HEADING = 'mb-3 text-sm font-semibold text-foreground'
const MUTED = 'text-sm text-muted-foreground'

function fmt(value: number | null, unit: string, scale = 1): string | null {
  return value === null ? null : `${scale === 1 ? value : (value / scale).toFixed(1)} ${unit}`
}

/**
 * WS1 T3 (spec rulings 1-3): the consultation workspace is the encounter. Reading it never
 * mutates (a checked-in visit shows "Start consultation", which POSTs). WORKSPACE_READ_ROLES read;
 * writes are offered only where the API would accept them (getWorkspace's canWrite/canRecordVitals).
 */
export default async function EncounterWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  // Must be the first statement -- see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!WORKSPACE_READ_ROLES.includes(session.role)) redirect(session.role === 'labs' ? '/labs' : '/')

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) notFound()
  const view = await getWorkspace(encounterId, session)
  if (!view) notFound()
  await logAudit(session, 'viewed encounter workspace', view.patient.id, `encounter=${encounterId}`)

  const { encounter, patient, canWrite } = view
  // The chart dialogs need their reference data only when the viewer may write.
  const [catalog, providers, labTests, sessionProvider, diagnosisCodes] = canWrite
    ? await Promise.all([listMedicationsWithInventory(), listAllProviders(), listLabTests(), resolveSessionProvider(session), patientDiagnosisCodes(patient.id)])
    : [[], [], [], null, []] as const

  const vitalsPanel = (
    <div className="space-y-5">
      {view.canRecordVitals && <VitalsForm encounterId={encounter.id} />}
      <div>
        <h2 className={HEADING}>Recorded this visit</h2>
        {view.vitals.length === 0 ? <p className={MUTED}>No vitals recorded yet.</p> : (
          <ul className="divide-y divide-border text-sm">
            {view.vitals.map((v) => (
              <li key={v.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                <span className="text-xs text-muted-foreground">{formatIstDateTime(v.recordedAt)} · {v.recordedByName}</span>
                {[
                  v.systolicMmhg !== null && v.diastolicMmhg !== null ? `BP ${v.systolicMmhg}/${v.diastolicMmhg}` : null,
                  fmt(v.pulseBpm, 'bpm'), fmt(v.tempDeciC, '°C', 10), v.spo2Pct !== null ? `SpO₂ ${v.spo2Pct}%` : null,
                  fmt(v.respRate, '/min'), fmt(v.weightG, 'kg', 1000), fmt(v.heightMm, 'cm', 10),
                  v.bmiTenths !== null ? `BMI ${(v.bmiTenths / 10).toFixed(1)}` : null,
                  v.painScore !== null ? `Pain ${v.painScore}/10` : null,
                ].filter(Boolean).map((t) => <span key={t} className="text-foreground">{t}</span>)}
                {v.flags.map((f) => <span key={f} className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warning-foreground">{f.replace('_', ' ')}</span>)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )

  const historyPanel = (
    <div className="space-y-6">
      <ConsultForm encounterId={encounter.id} initial={view.consult ?? {}} readOnly={!canWrite} />
      <div>
        <h2 className={HEADING}>Previous visits</h2>
        {view.history.length === 0 ? <p className={MUTED}>No earlier completed visits.</p> : (
          <ul className="divide-y divide-border text-sm">
            {view.history.map((h) => (
              <li key={h.encounterId} className="py-2">
                <p className="font-medium text-foreground">{formatIsoDate(h.encounterDate)} · {h.providerName}</p>
                {h.chiefComplaint && <p className="text-muted-foreground">{h.chiefComplaint}</p>}
                {h.diagnoses.length > 0 && <p className="text-xs text-muted-foreground">Diagnosis: {h.diagnoses.join('; ')}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )

  const chartLink = <Link href={`/patients/${patient.id}/medical-record`} className="font-medium text-primary hover:underline">medical record</Link>

  return (
    <div className="flex flex-col gap-4">
      <PatientStrip view={view} canEditAllergies={ALLERGY_WRITE_ROLES.includes(session.role)} />
      <WorkspaceShell
        panels={{
          vitals: vitalsPanel,
          history: historyPanel,
          diagnosis: <p className={MUTED}>Diagnoses for this patient are on the {chartLink}.</p>,
          rx: canWrite ? (
            <WorkspaceRxLauncher
              patientId={patient.id}
              catalog={[...catalog]}
              activeProviders={providers.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))}
              needsOnBehalfOf={session.role === 'admin' && sessionProvider === null}
              diagnosisCodes={[...diagnosisCodes]}
            />
          ) : <p className={MUTED}>Prescriptions are written by the visit&apos;s doctor while the visit is open. See the {chartLink}.</p>,
          orders: canWrite
            ? <WorkspaceOrdersLauncher patientId={patient.id} labTests={[...labTests]} />
            : <p className={MUTED}>Tests are ordered by the visit&apos;s doctor while the visit is open. See the {chartLink}.</p>,
          notes: (
            <div className="space-y-3">
              <NoteForm patientId={patient.id} canWrite={canWrite} />
              <p className={MUTED}>Earlier notes are on the {chartLink}.</p>
            </div>
          ),
        }}
      />
    </div>
  )
}
