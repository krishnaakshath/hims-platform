import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ALLERGY_WRITE_ROLES, WORKSPACE_READ_ROLES } from '@/lib/role-policy'
import { parseEncounterId } from '@/lib/encounters/ownership'
import { getWorkspace } from '@/lib/queries/encounter-workspace'
import { listAllProviders } from '@/lib/queries/providers'
import { listLabTests } from '@/lib/queries/lab-tests'
import { formatIsoDate, formatIstDateTime } from '@/lib/india-time'
import { PatientStrip } from '@/components/encounters/PatientStrip'
import { WorkspaceShell } from '@/components/encounters/WorkspaceShell'
import { VitalsForm } from '@/components/encounters/VitalsForm'
import { ConsultForm } from '@/components/encounters/ConsultForm'
import { NoteForm, NoteCard } from '@/components/NoteForm'
// WS1 T4: diagnoses, problem list, referral, advice and follow-up on the Diagnosis tab.
import { listEncounterDiagnoses, listProblemList } from '@/lib/queries/encounter-diagnoses'
import { listEncounterReferrals } from '@/lib/queries/referrals'
import { listDepartments } from '@/lib/queries/departments'
import { DiagnosisPicker, EncounterDiagnosisList } from '@/components/encounters/DiagnosisPicker'
import { ProblemList } from '@/components/encounters/ProblemList'
import { ReferralForm } from '@/components/encounters/ReferralForm'
import { FollowUpAdvice } from '@/components/encounters/FollowUpAdvice'
// end WS1 T4
// WS1 T5: visit notes and the Complete visit bar.
import { listNotesForEncounter } from '@/lib/queries/encounter-notes'
import { CompleteVisitBar } from '@/components/encounters/CompleteVisitBar'
// WS2 T14: the real Rx, Orders and Procedures panels, and the visit charges chip.
import { RxBuilder } from '@/components/encounters/RxBuilder'
import { OrdersPanel } from '@/components/encounters/OrdersPanel'
import { ProceduresPanel } from '@/components/encounters/ProceduresPanel'
import { listChargeLinesForContext } from '@/lib/queries/charge-capture'
import { lineTax } from '@/lib/billing/gst'

const HEADING = 'mb-3 text-sm font-semibold text-foreground'
const MUTED = 'text-sm text-muted-foreground'

function fmt(value: number | null, unit: string, scale = 1): string | null {
  return value === null ? null : `${scale === 1 ? value : (value / scale).toFixed(1)} ${unit}`
}

/**
 * WS2 T14: the visit's live charge lines (captured or invoiced; void left out) and their
 * GST-inclusive total, estimated intra-state per line as the pharmacy view does (the invoice
 * applies the place of supply).
 */
function visitCharges(lines: { status: string; taxablePaise: number; gstRateBp: number }[]): { totalPaise: number; lines: number } {
  const live = lines.filter((l) => l.status !== 'void')
  return { totalPaise: live.reduce((sum, l) => sum + lineTax(l.taxablePaise, l.gstRateBp, 'intra').totalPaise, 0), lines: live.length }
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
  // The order and referral forms need their reference data only when the viewer may write.
  const [providers, labTests] = canWrite ? await Promise.all([listAllProviders(), listLabTests()]) : [[], []] as const
  // WS1 T4
  const [visitDiagnoses, problemList, visitReferrals, departmentOptions, visitNotes, chargeLines] = await Promise.all([
    listEncounterDiagnoses(encounter.id), listProblemList(patient.id), listEncounterReferrals(encounter.id),
    canWrite ? listDepartments({ activeOnly: true }) : Promise.resolve([]),
    listNotesForEncounter(encounter.id), // WS1 T5
    listChargeLinesForContext({ encounterId: encounter.id }), // WS2 T14
  ])
  // WS1 T5: the author (or an admin) signs a draft, as on the medical record; signing stays open after completion.
  const mayWriteNotes = session.role === 'pi' || session.role === 'admin'

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
      <ConsultForm encounterId={encounter.id} initial={view.consult ?? {}} readOnly={!canWrite} omit={['advice']} />
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

  // WS1 T4: diagnoses are writable until SP6 codes the visit; referral, advice and follow-up while it is open.
  const diagnosisPanel = (
    <div className="space-y-6">
      <section>
        <h2 className={HEADING}>Diagnoses this visit</h2>
        <EncounterDiagnosisList
          encounterId={encounter.id}
          canWrite={canWrite}
          items={visitDiagnoses.map((d) => ({
            id: d.id, label: d.codeDisplay || d.description, code: d.code === '' ? null : d.code,
            diagnosisType: d.diagnosisType, codingStatus: d.codingStatus, onProblemList: d.onProblemList,
          }))}
        />
        {canWrite && <div className="mt-3"><DiagnosisPicker encounterId={encounter.id} onDate={encounter.encounterDate} /></div>}
      </section>
      <section>
        <h2 className={HEADING}>Problem list</h2>
        <ProblemList items={problemList} />
      </section>
      <section>
        <h2 className={HEADING}>Advice and follow-up</h2>
        <FollowUpAdvice encounterId={encounter.id} patientId={patient.id} providerId={encounter.providerId} initialAdvice={view.consult?.advice ?? null} readOnly={!canWrite} />
      </section>
      <section>
        <h2 className={HEADING}>Referral</h2>
        {visitReferrals.length > 0 && (
          <ul className="mb-3 divide-y divide-border text-sm" aria-label="Referrals this visit">
            {visitReferrals.map((r) => (
              <li key={r.id} className="py-1.5">
                <span className="text-foreground">{r.kind === 'external' ? 'External: ' : ''}{r.target}</span>
                <span className="ml-2 text-xs capitalize text-muted-foreground">{r.urgency} · {r.status}</span>
              </li>
            ))}
          </ul>
        )}
        {canWrite
          ? <ReferralForm encounterId={encounter.id} departments={departmentOptions.map((d) => ({ id: d.id, name: d.name }))}
              doctors={providers.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))} />
          : visitReferrals.length === 0 && <p className={MUTED}>No referral from this visit.</p>}
      </section>
    </div>
  )

  const chartLink = <Link href={`/patients/${patient.id}/medical-record`} className="font-medium text-primary hover:underline">medical record</Link>

  return (
    <div className="flex flex-col gap-4">
      <PatientStrip view={view} canEditAllergies={ALLERGY_WRITE_ROLES.includes(session.role)} visitCharges={visitCharges(chargeLines)} />
      <WorkspaceShell
        panels={{
          vitals: vitalsPanel,
          history: historyPanel,
          diagnosis: diagnosisPanel,
          rx: canWrite ? (
            <RxBuilder
              encounterId={encounter.id}
              patientAllergies={patient.allergies.map((a) => ({ allergen: a.allergen, severity: a.severity }))}
              allergyStatus={patient.allergyStatus}
              canWrite
            />
          ) : <p className={MUTED}>Prescriptions are written by the visit&apos;s doctor while the visit is open. See the {chartLink}.</p>,
          // Readers see the visit's orders and procedures; only the writer gets the order forms.
          orders: (
            <div className="space-y-6">
              <OrdersPanel encounterId={encounter.id} patientId={patient.id} labTests={[...labTests]} canWrite={canWrite} />
              <ProceduresPanel encounterId={encounter.id} canWrite={canWrite} />
            </div>
          ),
          notes: (
            <div className="space-y-3">
              <NoteForm patientId={patient.id} canWrite={canWrite} encounterId={encounter.id} />
              {visitNotes.length > 0 && (
                <div className="space-y-2.5">
                  {visitNotes.map((n) => (
                    <NoteCard
                      key={n.id}
                      patientId={patient.id}
                      canSign={mayWriteNotes && n.status === 'draft' && (n.authorName === session.name || session.role === 'admin')}
                      note={{
                        id: n.id, noteType: n.noteType, authorName: n.authorName, authorRole: n.authorRole,
                        subjective: n.subjective, objective: n.objective, assessment: n.assessment, plan: n.plan,
                        status: n.status, createdAt: n.createdAt.toISOString(), signedAt: n.signedAt?.toISOString() ?? null,
                      }}
                    />
                  ))}
                </div>
              )}
              <p className={MUTED}>Earlier notes are on the {chartLink}.</p>
            </div>
          ),
        }}
        footer={canWrite || encounter.status === 'completed'
          ? <CompleteVisitBar encounterId={encounter.id} status={encounter.status} canComplete={canWrite} />
          : undefined}
      />
    </div>
  )
}
