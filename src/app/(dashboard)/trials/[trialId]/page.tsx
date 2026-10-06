import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { FlaskConical, CheckCircle2, XCircle, Users, AlertTriangle, Pill, FileCheck2 } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { listAllTrials } from '@/lib/queries/trials'
import { listScreeningsForTrial } from '@/lib/queries/trial-screenings'
import { listPatientNameOptions } from '@/lib/queries/patients'
import { listAdverseEvents, listDrugAccountability, listRegulatoryDocuments } from '@/lib/queries/trial-compliance'
import { Tabs } from '@/components/Tabs'
import { BackLink } from '@/components/BackLink'
import { StatusChip } from '@/components/StatusChip'
import { AdverseEventsPanel, DrugAccountabilityPanel, RegulatoryDocumentsPanel } from '@/components/TrialCompliancePanels'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const HEADING = 'mb-2 border-l-2 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

// A lighter row than EvidenceCard for the trial-level screening buckets --
// every criterion listed here already shares its bucket's verdict (all red
// in "Rejected", all non-green in "Needs verification"), so repeating a
// full status chip per criterion (as EvidenceCard does, correctly, when
// verdicts vary within one view) is just visual noise here.
function CriterionRow({ criterion }: { criterion: { criterionText: string; evidenceQuote: string | null; evidenceSourceDoc: string | null; evidenceSourceDate: string | null } }) {
  return (
    <div className="border-t border-border pt-2 first:border-t-0 first:pt-0">
      <p className="text-sm text-foreground">{criterion.criterionText}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {criterion.evidenceQuote ? `“${criterion.evidenceQuote}”` : 'No evidence available.'}
        {criterion.evidenceSourceDoc && <> — {criterion.evidenceSourceDoc}{criterion.evidenceSourceDate ? ` · ${criterion.evidenceSourceDate}` : ''}</>}
      </p>
    </div>
  )
}

export default async function TrialDetailPage({ params }: { params: Promise<{ trialId: string }> }) {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const { trialId } = await params
  const trials = await listAllTrials()
  const trial = trials.find((t) => t.id === trialId)
  if (!trial) notFound()

  const canWriteCompliance = ['crc', 'pi', 'admin'].includes(session.role)
  const [adverseEvents, drugAccountability, regulatoryDocuments, patientOptions] = await Promise.all([
    listAdverseEvents(trial.id),
    listDrugAccountability(trial.id),
    listRegulatoryDocuments(trial.id),
    listPatientNameOptions(),
  ])

  const requiredStableMeds = trial.medicationClasses.filter((m) => m.ruleType === 'required_stable')
  const washoutMeds = trial.medicationClasses.filter((m) => m.ruleType === 'washout_exclusion')

  const screenedPatients = await listScreeningsForTrial(trial.id)
  const passedPatients = screenedPatients.filter((p) => p.overallStatus === 'green')
  const needsVerificationPatients = screenedPatients.filter((p) => p.overallStatus === 'yellow')
  const rejectedPatients = screenedPatients.filter((p) => p.overallStatus === 'red')

  const inclusionTab = (
    <div className="space-y-4">
      <section className={SECTION}>
        <h3 className={`${HEADING} border-emerald-500/50`}>Age range</h3>
        <p className="text-sm text-foreground">{trial.ageMin}–{trial.ageMax} years old</p>
      </section>
      <section className={SECTION}>
        <h3 className={`${HEADING} border-emerald-500/50`}>Diagnosis codes</h3>
        <ul className="space-y-1.5 text-sm text-foreground">
          {trial.diagnosisCodes.map((d) => <li key={d.code}>{d.code} — {d.description}</li>)}
        </ul>
      </section>
      <section className={SECTION}>
        <h3 className={`${HEADING} border-emerald-500/50`}>Rating scale(s)</h3>
        <ul className="space-y-1.5 text-sm text-foreground">
          {trial.ratingScales.map((r) => <li key={r.name}>{r.name} — {r.description}</li>)}
        </ul>
        {trial.minRatingScaleScore != null && (
          <p className="mt-2 text-xs text-muted-foreground">Minimum qualifying score: {trial.minRatingScaleScore}</p>
        )}
      </section>
      {requiredStableMeds.length > 0 && (
        <section className={SECTION}>
          <h3 className={`${HEADING} border-emerald-500/50`}>Required stable medication</h3>
          <ul className="space-y-1.5 text-sm text-foreground">
            {requiredStableMeds.map((m) => <li key={m.className}>{m.className} — {m.rule} (≥{m.washoutDays} days)</li>)}
          </ul>
        </section>
      )}
    </div>
  )

  const exclusionTab = (
    <div className="space-y-4">
      <section className={SECTION}>
        <h3 className={`${HEADING} border-red-500/50`}>Excluded medication classes</h3>
        {washoutMeds.length === 0 ? (
          <p className="text-sm text-muted-foreground">None configured.</p>
        ) : (
          <ul className="space-y-1.5 text-sm text-foreground">
            {washoutMeds.map((m) => <li key={m.className}>{m.className} — {m.rule} ({m.washoutDays}-day washout)</li>)}
          </ul>
        )}
      </section>
      <section className={SECTION}>
        <h3 className={`${HEADING} border-red-500/50`}>Disqualifying diagnoses</h3>
        {trial.exclusionDiagnoses.length === 0 ? (
          <p className="text-sm text-muted-foreground">None configured.</p>
        ) : (
          <ul className="space-y-1.5 text-sm text-foreground">
            {trial.exclusionDiagnoses.map((d) => <li key={d.code}>{d.code} — {d.description}</li>)}
          </ul>
        )}
      </section>
    </div>
  )

  const patientsTab = (
    <div className="space-y-4">
      <section className={SECTION}>
        <h3 className={`${HEADING} border-emerald-500/50`}>Passed ({passedPatients.length})</h3>
        {passedPatients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No patients have passed screening for this trial yet.</p>
        ) : (
          <ul className="space-y-2">
            {passedPatients.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
                <Link href={`/patients/${p.id}`} className="text-sm font-medium text-foreground hover:underline">
                  {p.name} <span className="font-mono text-xs text-muted-foreground">({p.id})</span>
                </Link>
                <StatusChip status={p.overallStatus} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION}>
        <h3 className={`${HEADING} border-amber-500/50`}>Needs verification ({needsVerificationPatients.length})</h3>
        {needsVerificationPatients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No patients currently need verification for this trial.</p>
        ) : (
          <div className="space-y-4">
            {needsVerificationPatients.map((p) => {
              const outstanding = p.criteria.filter((c) => c.verdict !== 'green')
              return (
                <div key={p.id} className="rounded-md border border-border bg-secondary/40 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Link href={`/patients/${p.id}`} className="text-sm font-medium text-foreground hover:underline">
                      {p.name} <span className="font-mono text-xs text-muted-foreground">({p.id})</span>
                    </Link>
                    <StatusChip status={p.overallStatus} />
                  </div>
                  <div className="space-y-2">
                    {outstanding.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No criterion detail recorded for this screening.</p>
                    ) : (
                      outstanding.map((c) => <CriterionRow key={c.id} criterion={c} />)
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className={SECTION}>
        <h3 className={`${HEADING} border-red-500/50`}>Rejected / excluded ({rejectedPatients.length})</h3>
        {rejectedPatients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No patients have been excluded from this trial.</p>
        ) : (
          <div className="space-y-4">
            {rejectedPatients.map((p) => {
              const failing = p.criteria.filter((c) => c.verdict === 'red')
              return (
                <div key={p.id} className="rounded-md border border-border bg-secondary/40 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Link href={`/patients/${p.id}`} className="text-sm font-medium text-foreground hover:underline">
                      {p.name} <span className="font-mono text-xs text-muted-foreground">({p.id})</span>
                    </Link>
                    <StatusChip status={p.overallStatus} />
                  </div>
                  <div className="space-y-2">
                    {failing.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No criterion detail recorded for this screening.</p>
                    ) : (
                      failing.map((c) => <CriterionRow key={c.id} criterion={c} />)
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )

  return (
    <div className="max-w-4xl space-y-6">
      <BackLink href="/trials" label="Back to Trials" />
      <div className={`${SECTION} flex items-center gap-4`}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          <FlaskConical className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-foreground">{trial.name}</h1>
          <p className="text-xs text-muted-foreground">{trial.nctNumber} · {trial.site} · {trial.studyDrug}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-lg font-bold tabular-nums text-foreground">{trial.ageMin}–{trial.ageMax}</p>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Age range</p>
        </div>
        <div className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-center">
          <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" />
          <p className="text-sm font-semibold text-emerald-700">{trial.diagnosisCodes.length + requiredStableMeds.length + (trial.minRatingScaleScore != null ? 1 : 0)} inclusion rules</p>
        </div>
        <div className="flex items-center justify-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-center">
          <XCircle className="h-4 w-4 text-red-700" aria-hidden="true" />
          <p className="text-sm font-semibold text-red-700">{washoutMeds.length + trial.exclusionDiagnoses.length} exclusion rules</p>
        </div>
      </div>

      <Tabs tabs={[
        { id: 'inclusion', label: <><CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" />Inclusion criteria</>, content: inclusionTab },
        { id: 'exclusion', label: <><XCircle className="h-4 w-4 text-red-700" aria-hidden="true" />Exclusion criteria</>, content: exclusionTab },
        { id: 'patients', label: <><Users className="h-4 w-4 text-primary" aria-hidden="true" />Screening results ({screenedPatients.length})</>, content: patientsTab },
        {
          id: 'adverse-events',
          label: <><AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />Adverse Events ({adverseEvents.length})</>,
          content: <AdverseEventsPanel trialId={trial.id} events={adverseEvents} patients={patientOptions} canWrite={canWriteCompliance} />,
        },
        {
          id: 'drug-accountability',
          label: <><Pill className="h-4 w-4 text-primary" aria-hidden="true" />Drug Accountability</>,
          content: <DrugAccountabilityPanel trialId={trial.id} entries={drugAccountability} patients={patientOptions} canWrite={canWriteCompliance} />,
        },
        {
          id: 'regulatory-documents',
          label: <><FileCheck2 className="h-4 w-4 text-emerald-700" aria-hidden="true" />Regulatory Binder ({regulatoryDocuments.length})</>,
          content: <RegulatoryDocumentsPanel trialId={trial.id} documents={regulatoryDocuments} canWrite={canWriteCompliance} />,
        },
      ]} />
    </div>
  )
}
