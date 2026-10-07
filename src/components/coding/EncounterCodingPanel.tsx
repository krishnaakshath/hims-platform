// SP6 Task 13: the chart's "Visit coding" panel. Per recent visit: date, type and doctor, the
// encounter coding status, its diagnoses and procedures with their coding chips, and its open
// coding queries. Doctors (CODE_PROPOSE_ROLES, pi only) may propose while coding is open
// (`doctorMayPropose`: uncoded / in progress / queried); once the visit is coded or finalised they
// are pointed at the query reply instead. CODING_QUERY_RESPOND_ROLES get a reply box. Everyone else
// on the chart (crc, and admin apart from replies) sees it read-only. Renders on the server (dates are formatted here with the
// fixed-zone IST formatters); only the forms are client components.
import { CODE_SYSTEM_LABEL } from '@/lib/coding/code-systems'
import { doctorMayPropose, type CodeEntryStatus } from '@/lib/coding/status'
import type { EncounterType } from '@/lib/encounters/status'
import { DEFAULT_TIMEZONE, formatDateTimeIn, formatIsoDate, todayIsoIn } from '@/lib/india-time'
import type { ChartEncounterCoding, WorkspaceDiagnosis, WorkspaceProcedure, WorkspaceQuery } from '@/lib/queries/coding-workspace'
import { CodingStatusBadge } from './CodingStatusBadge'
import { SampleBadge } from './CodePicker'
import { AddProcedureForm, ProposeDiagnosisForm, QueryReplyBox } from './ChartCodingForms'

const ENCOUNTER_TYPE_LABEL: Record<EncounterType, string> = { opd: 'OPD', ipd: 'IPD', lab: 'Lab' }
const DIAGNOSIS_TYPE_LABEL = { primary: 'Primary', secondary: 'Secondary', provisional: 'Provisional' } as const
const QUERY_STATUS_LABEL = { open: 'Awaiting reply', answered: 'Answered', closed: 'Closed', withdrawn: 'Withdrawn' } as const

function EntryChip({ status, proposedByName }: { status: CodeEntryStatus; proposedByName: string | null }) {
  const base = 'inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium'
  if (status === 'coded') return <span className={`${base} border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100`}>Coded</span>
  if (status === 'proposed') return <span className={`${base} border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100`}>{`Proposed by ${proposedByName ?? 'a doctor'}`}</span>
  return <span className={`${base} border-border bg-muted text-foreground`}>Uncoded</span>
}

function EntryCode({ e }: { e: WorkspaceDiagnosis | WorkspaceProcedure }) {
  if (!e.code) return <span className="text-xs text-muted-foreground">No code</span>
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {e.kind && <span className="text-xs text-muted-foreground">{CODE_SYSTEM_LABEL[e.kind]}</span>}
      <span className="font-mono text-xs font-semibold">{e.code}</span>
      {e.isSample && <SampleBadge />}
    </span>
  )
}

function EntryList({ title, emptyText, children }: { title: string; emptyText: string; children: React.ReactNode[] }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children.length === 0
        ? <p className="text-sm text-muted-foreground">{emptyText}</p>
        : <ul className="divide-y divide-border text-sm">{children}</ul>}
    </div>
  )
}

function QueryItem({ q, canRespond }: { q: WorkspaceQuery; canRespond: boolean }) {
  return (
    <li className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-xs text-muted-foreground">
        {`Coding query from ${q.raisedByName} to ${q.addressedToName} · ${formatDateTimeIn(q.raisedAt)} · ${QUERY_STATUS_LABEL[q.status]}`}
      </p>
      <p className="whitespace-pre-wrap text-sm font-medium text-foreground">{q.question}</p>
      {q.responses.length > 0 && (
        <ol className="space-y-1.5 border-l-2 border-border ps-3">
          {q.responses.map((r) => (
            <li key={r.id} className="text-sm">
              <p className="text-xs text-muted-foreground">{`${r.authorName} · ${formatDateTimeIn(r.createdAt)}`}</p>
              <p className="whitespace-pre-wrap">{r.body}</p>
            </li>
          ))}
        </ol>
      )}
      {canRespond && <QueryReplyBox queryId={q.id} question={q.question} />}
    </li>
  )
}

export function EncounterCodingPanel({ patientId, encounters, canPropose, canRespond }: {
  patientId: string
  encounters: ChartEncounterCoding[]
  canPropose: boolean
  canRespond: boolean
}) {
  if (encounters.length === 0) {
    return <p className="text-sm text-muted-foreground">No visits to code yet.</p>
  }
  const todayIso = todayIsoIn(DEFAULT_TIMEZONE)
  return (
    <ul className="space-y-4" data-patient-id={patientId}>
      {encounters.map((e) => {
        const open = doctorMayPropose(e.codingStatus)
        const headingId = `visit-coding-${e.encounterId}`
        return (
          <li key={e.encounterId}>
            <article aria-labelledby={headingId} className="space-y-3 rounded-lg border border-border p-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={headingId} className="text-sm font-semibold text-foreground">
                  {`${formatIsoDate(e.encounterDate)} · ${ENCOUNTER_TYPE_LABEL[e.encounterType]} · ${e.providerName}`}
                </h3>
                <CodingStatusBadge status={e.codingStatus} />
              </header>

              <div className="grid gap-3 md:grid-cols-2">
                <EntryList title="Diagnoses" emptyText="No diagnoses for this visit.">
                  {e.diagnoses.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 space-y-0.5">
                        <span className="block">{d.description}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <EntryCode e={d} />
                          {d.type && <span className="text-xs text-muted-foreground">{DIAGNOSIS_TYPE_LABEL[d.type]}</span>}
                        </span>
                      </span>
                      <EntryChip status={d.codingStatus} proposedByName={d.proposedByName} />
                    </li>
                  ))}
                </EntryList>
                <EntryList title="Procedures" emptyText="No procedures for this visit.">
                  {e.procedures.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 space-y-0.5">
                        <span className="block">{p.description}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <EntryCode e={p} />
                          <span className="text-xs text-muted-foreground">{formatIsoDate(p.performedOn)}</span>
                        </span>
                      </span>
                      <EntryChip status={p.codingStatus} proposedByName={p.proposedByName} />
                    </li>
                  ))}
                </EntryList>
              </div>

              {canPropose && (open ? (
                <div className="flex flex-wrap items-start gap-3">
                  <ProposeDiagnosisForm encounterId={e.encounterId} encounterDate={e.encounterDate} hasPrimary={e.diagnoses.some((d) => d.type === 'primary')} />
                  <AddProcedureForm encounterId={e.encounterId} encounterDate={e.encounterDate} todayIso={todayIso} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Coding is closed for this visit; send changes through a coding query reply.</p>
              ))}

              {e.openQueries.length > 0 && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Coding queries</h4>
                  <ul className="space-y-2">
                    {e.openQueries.map((q) => <QueryItem key={q.id} q={q} canRespond={canRespond} />)}
                  </ul>
                </div>
              )}
            </article>
          </li>
        )
      })}
    </ul>
  )
}
