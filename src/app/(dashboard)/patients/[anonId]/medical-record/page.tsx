import { formatIstDate, formatIstDateTime } from '@/lib/india-time'
import { notFound, redirect } from 'next/navigation'
import { CalendarClock, CalendarCheck2, Stethoscope, Pill, ClipboardList } from 'lucide-react'
import { BackLink } from '@/components/BackLink'
import { PatientAvatar } from '@/components/PatientAvatar'
import { AllergyBadge } from '@/components/AllergyBadge'
import { NoteForm, NoteCard } from '@/components/NoteForm'
import { InsuranceCardUpload } from '@/components/InsuranceCardUpload'
import { LabResultsSection } from '@/components/LabResultsSection'
import { CarePlanSection } from '@/components/CarePlanSection'
import { MedicationHistorySection } from '@/components/MedicationHistorySection'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getPatientDetail } from '@/lib/queries/patients'
import { listNotesForPatient } from '@/lib/queries/encounter-notes'
import { getPayerName } from '@/lib/queries/payers'
import { listDispensesForPatient } from '@/lib/queries/medication-dispenses'
import { listMedicationsWithInventory } from '@/lib/queries/medications'
import { listAllProviders } from '@/lib/queries/providers'
import { listOrdersForPatient } from '@/lib/queries/lab-orders'
import { listLabTests } from '@/lib/queries/lab-tests'
import { listFormSubmissions } from '@/lib/queries/form-submissions'
import { listCarePlansForPatient } from '@/lib/queries/care-plans'
import { resolveSessionProvider } from '@/lib/provider-identity'
// SP6
import { CODE_PROPOSE_ROLES, CODING_QUERY_RESPOND_ROLES } from '@/lib/role-policy'
import { listEncounterCodingForPatient } from '@/lib/queries/coding-workspace'
import { EncounterCodingPanel } from '@/components/coding/EncounterCodingPanel'
// end SP6

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const SECTION_HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function formatDate(value: string | Date | null): string {
  if (!value) return '—'
  return formatIstDate(value)
}

function VisitStat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold text-foreground">{value}</p>
      </div>
    </div>
  )
}

const PLAN_TYPE_LABEL: Record<string, string> = {
  ppo: 'PPO', hmo: 'HMO', epo: 'EPO', pos: 'POS', medicare: 'Medicare', medicaid: 'Medicaid',
}

const RELATIONSHIP_LABEL: Record<string, string> = {
  self: 'Self', spouse: 'Spouse', child: 'Child', other: 'Other',
}

function InsuranceField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value ?? '—'}</p>
    </div>
  )
}

/**
 * Dedicated, standalone page for a single patient's medical record --
 * carved out of the Patient Detail page's Overview tab so "open the chart"
 * is a real navigation to its own URL rather than a tab buried inside the
 * screening/verification workflow. Reuses getPatientDetail(); it's the same
 * cached data the Overview tab used to render.
 */
export default async function MedicalRecordPage({ params }: { params: Promise<{ anonId: string }> }) {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  // Labs reads results and imaging from its own worklist, not the chart
  // (RBAC ruling 3); every other non-clinical role goes home. Both before
  // `await params` and any query.
  if (session.role === 'labs') redirect('/labs')
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')
  const { anonId } = await params

  const patient = await getPatientDetail(anonId)
  if (!patient) notFound()
  const notes = await listNotesForPatient(anonId)
  const primaryPayerName = await getPayerName(patient.primaryPayerId)
  const secondaryPayerName = await getPayerName(patient.secondaryPayerId)
  const dispenses = await listDispensesForPatient(anonId)
  const medicationCatalog = await listMedicationsWithInventory()
  const medicationById = new Map(medicationCatalog.map((m) => [m.id, m]))
  const allProviders = await listAllProviders()
  const sessionProvider = await resolveSessionProvider(session)
  const [labOrders, labTests] = await Promise.all([listOrdersForPatient(anonId), listLabTests()])
  const screeningSubmissions = (await listFormSubmissions({ patientId: anonId, status: 'completed' })).filter((s) => s.bandLabel !== null)
  const carePlans = await listCarePlansForPatient(anonId)
  // SP6: the patient's recent visits with their coding; doctors propose, doctors/admin reply, crc reads.
  const visitCoding = await listEncounterCodingForPatient(anonId)
  const canProposeCodes = CODE_PROPOSE_ROLES.includes(session.role)
  const canRespondToCodingQueries = CODING_QUERY_RESPOND_ROLES.includes(session.role)
  await logAudit(session, 'viewed patient medical record', anonId)

  const name = patient.name
  const canWriteInsurance = ['admin', 'crc'].includes(session.role)
  // Matches POST /api/patients/[anonId]/lab-orders's own role gate (spec §8: ordering is a clinical action).
  const canOrderLabs = ['admin', 'pi'].includes(session.role)
  // Matches POST /api/patients/[anonId]/prescriptions's own role gate (spec §10: prescribing is the clinical tier).
  const canPrescribe = ['admin', 'pi'].includes(session.role)
  // admin needs the explicit on-behalf-of picker only when its own session
  // has no provider row behind it (spec §5).
  const needsOnBehalfOf = session.role === 'admin' && sessionProvider === null
  // Built from the FULL roster (listAllProviders), not just active ones, so
  // a prescription written by a since-deactivated provider still shows its
  // prescriber.
  const prescriberById = Object.fromEntries(allProviders.map((p) => [p.id, { name: p.name, credentials: p.credentials, specialty: p.specialty }]))
  const specialties = [...new Set(allProviders.filter((p) => p.isActive).map((p) => p.specialty))].sort()
  const activeProviders = allProviders.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))

  return (
    <div className="max-w-4xl space-y-6">
      <BackLink href={`/patients/${anonId}`} label="Back to Patient" />

      <div className={SECTION}>
        <div className="flex items-center gap-4">
          <PatientAvatar name={name} size="lg" />
          <div>
            <h1 className="text-xl font-bold text-foreground">{name}</h1>
            <p className="font-mono text-xs text-muted-foreground">{patient.id} · DOB {patient.dob}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Chart data as of {formatIstDateTime(patient.chartDataAsOf)}</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <VisitStat icon={CalendarClock} label="Last Visit" value={formatDate(patient.lastApptDate)} />
          <VisitStat icon={CalendarCheck2} label="Next Appointment" value={formatDate(patient.nextApptDate)} />
          <VisitStat icon={Stethoscope} label="Current Provider" value={patient.currentProvider ?? '—'} />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <a href={`/api/patients/${anonId}/fhir/Bundle`} className="rounded-md border border-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5">Download as FHIR (JSON)</a>
          <a href={`/api/patients/${anonId}/ccda`} className="rounded-md border border-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5">Download as C-CDA (XML)</a>
        </div>
      </div>

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Diagnoses</h2>
        {patient.diagnoses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No diagnoses recorded.</p>
        ) : (
          <ul className="space-y-1.5 text-sm text-foreground">
            {patient.diagnoses.map((d) => (
              <li key={`dx-${d.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1.5 last:border-b-0">
                {/* SP6: a legacy row (no visit) keeps its free-text code, shown as unverified (ruling 3). */}
                {d.code && <span className="font-mono text-xs text-muted-foreground">{d.code}</span>}
                {d.code && d.encounterId === null && <span className="text-xs text-muted-foreground">(unverified)</span>}
                {d.code && <span aria-hidden="true">—</span>}
                <span>{d.description}</span>
                {d.encounterId === null && (
                  <span className="inline-flex whitespace-nowrap rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">Uncoded (legacy)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* SP6: Visit coding */}
      <section id="visit-coding" aria-labelledby="visit-coding-heading" className={SECTION}>
        <h2 id="visit-coding-heading" className={SECTION_HEADING}>Visit coding</h2>
        <EncounterCodingPanel
          patientId={anonId}
          encounters={visitCoding}
          canPropose={canProposeCodes}
          canRespond={canRespondToCodingQueries}
        />
      </section>
      {/* end SP6 */}

      <section className={SECTION}>
        <MedicationHistorySection
          patientId={anonId}
          episodes={patient.medications}
          prescriberById={prescriberById}
          catalog={medicationCatalog}
          specialties={specialties}
          activeProviders={activeProviders}
          needsOnBehalfOf={needsOnBehalfOf}
          canPrescribe={canPrescribe}
          diagnosisCodes={patient.diagnoses.map((d) => d.code)}
        />
      </section>

      <section className={SECTION}>
        <CarePlanSection patientId={anonId} plans={carePlans} canWrite={['admin', 'pi'].includes(session.role)} />
      </section>

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Medications Dispensed</h2>
        {dispenses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No medications dispensed.</p>
        ) : (
          <ul className="space-y-1.5">
            {dispenses.map((d) => {
              const med = medicationById.get(d.medicationId)
              return (
                <li key={`dispense-${d.id}`} className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
                  <Pill className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{med?.name ?? `Medication #${d.medicationId}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.quantity} {med?.unit ?? 'units'} · dispensed by {d.dispensedByName} · {formatDate(d.dispensedAt)}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Screening Questionnaires</h2>
        {screeningSubmissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No screening questionnaires completed.</p>
        ) : (
          <ul className="space-y-1.5">
            {screeningSubmissions.map((s) => (
              <li key={`screening-${s.id}`} className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
                <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{s.templateName}</p>
                  <p className="text-xs text-muted-foreground">
                    Completed {formatDate(s.completedDate)} · Score: {s.totalScore} ({s.bandLabel})
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Allergies</h2>
        {patient.allergies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No known allergies recorded.</p>
        ) : (
          <div className="space-y-2">
            {patient.allergies.map((a) => <AllergyBadge key={a.id} allergen={a.allergen} reaction={a.reaction} severity={a.severity} />)}
          </div>
        )}
      </section>

      <section className={SECTION}>
        <h2 className={SECTION_HEADING}>Insurance</h2>
        {patient.primaryPayerId === null ? (
          <p className="text-sm text-muted-foreground">No insurance on file.</p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Primary</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <InsuranceField label="Payer" value={primaryPayerName} />
                <InsuranceField label="Member ID" value={patient.primaryMemberId} />
                <InsuranceField label="Group Number" value={patient.primaryGroupNumber} />
                <InsuranceField label="Plan Type" value={patient.primaryPlanType ? PLAN_TYPE_LABEL[patient.primaryPlanType] : null} />
                <InsuranceField label="Subscriber" value={patient.primarySubscriberName} />
                <InsuranceField label="Relationship" value={patient.primarySubscriberRelationship ? RELATIONSHIP_LABEL[patient.primarySubscriberRelationship] : null} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Card — Front</p>
                  {patient.primaryCardFrontUrl && (
                    <a href={`/api/patients/${anonId}/insurance-card/front`} target="_blank" rel="noopener noreferrer" className="mb-1.5 block">
                      <img src={`/api/patients/${anonId}/insurance-card/front`} alt="Primary insurance card, front" className="h-24 w-auto rounded-md border border-border object-cover" />
                    </a>
                  )}
                  <InsuranceCardUpload anonId={anonId} side="front" hasImage={!!patient.primaryCardFrontUrl} canWrite={canWriteInsurance} />
                </div>
                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Card — Back</p>
                  {patient.primaryCardBackUrl && (
                    <a href={`/api/patients/${anonId}/insurance-card/back`} target="_blank" rel="noopener noreferrer" className="mb-1.5 block">
                      <img src={`/api/patients/${anonId}/insurance-card/back`} alt="Primary insurance card, back" className="h-24 w-auto rounded-md border border-border object-cover" />
                    </a>
                  )}
                  <InsuranceCardUpload anonId={anonId} side="back" hasImage={!!patient.primaryCardBackUrl} canWrite={canWriteInsurance} />
                </div>
              </div>
            </div>

            {patient.secondaryPayerId !== null && (
              <div className="border-t border-border pt-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Secondary</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                  <InsuranceField label="Payer" value={secondaryPayerName} />
                  <InsuranceField label="Member ID" value={patient.secondaryMemberId} />
                  <InsuranceField label="Group Number" value={patient.secondaryGroupNumber} />
                  <InsuranceField label="Plan Type" value={patient.secondaryPlanType ? PLAN_TYPE_LABEL[patient.secondaryPlanType] : null} />
                  <InsuranceField label="Subscriber" value={patient.secondarySubscriberName} />
                  <InsuranceField label="Relationship" value={patient.secondarySubscriberRelationship ? RELATIONSHIP_LABEL[patient.secondarySubscriberRelationship] : null} />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className={SECTION}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className={SECTION_HEADING}>Notes</h2>
          <NoteForm patientId={anonId} canWrite={['pi', 'admin'].includes(session.role)} />
        </div>
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes recorded.</p>
        ) : (
          <div className="space-y-2.5">
            {notes.map((n) => (
              <NoteCard
                key={n.id}
                patientId={anonId}
                canSign={n.status === 'draft' && (n.authorName === session.name || session.role === 'admin')}
                note={{
                  id: n.id,
                  noteType: n.noteType,
                  authorName: n.authorName,
                  authorRole: n.authorRole,
                  subjective: n.subjective,
                  objective: n.objective,
                  assessment: n.assessment,
                  plan: n.plan,
                  status: n.status,
                  createdAt: n.createdAt.toString(),
                  signedAt: n.signedAt?.toString() ?? null,
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className={SECTION}>
        <LabResultsSection patientId={anonId} orders={labOrders} labTests={labTests} canOrder={canOrderLabs} />
      </section>
    </div>
  )
}
