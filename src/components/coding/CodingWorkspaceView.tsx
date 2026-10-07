// The coding workspace for one encounter (/coding/encounters/[id]). Receives a mapped view only:
// the coder-minimum patient header (name, UHID, sex, age in years), the visit, its coding, entries,
// signed notes (plain text, read-only), queries, history and the rule issues, with every date
// pre-formatted on the server (IST). Finalised coding is read-only apart from Reopen.
import type { Role } from '@/lib/auth'
import type { CodingIssue } from '@/lib/coding/rules'
import { CODING_STATUS_LABEL, type CodingEventAction, type EncounterCodingStatus } from '@/lib/coding/status'
import { CodingStatusBadge } from './CodingStatusBadge'
import { CodingActions, codingActionAvailable } from './CodingActions'
import { CodingIssuesPanel } from './CodingIssuesPanel'
import { CodingQueriesPanel, type QueryView } from './CodingQueriesPanel'
import { EntryEditor, type EntryView } from './EntryEditor'

export interface WorkspaceView {
  encounterId: number
  patient: { name: string; uhid: string | null; sexLabel: string; ageYears: number }
  encounter: {
    typeLabel: string
    visitTypeLabel: string
    dateIso: string
    dateLabel: string
    completedLabel: string | null
    isCompleted: boolean
    departmentName: string | null
    providerId: number
    providerName: string
  }
  coding: {
    status: EncounterCodingStatus
    assignedToUserId: number | null
    assignedToName: string | null
    codedLine: string | null
    finalisedLine: string | null
    reopenCount: number
  }
  diagnoses: EntryView[]
  procedures: EntryView[]
  notes: { id: number; title: string; byline: string; sections: { label: string; text: string }[] }[]
  queries: QueryView[]
  events: { key: string; actionLabel: string; change: string; byName: string; atLabel: string; reason: string | null }[]
  issues: CodingIssue[]
}

export const CODING_EVENT_LABEL: Record<CodingEventAction, string> = {
  claim: 'Claimed',
  assign: 'Assigned',
  release: 'Released',
  raise_query: 'Raised a query',
  resume: 'Resumed coding',
  mark_coded: 'Marked coded',
  finalise: 'Finalised',
  reopen: 'Reopened',
  edit_after_coded: 'Edited after coding',
}

export function codingStatusChange(from: EncounterCodingStatus, to: EncounterCodingStatus): string {
  return from === to ? CODING_STATUS_LABEL[to] : `${CODING_STATUS_LABEL[from]} → ${CODING_STATUS_LABEL[to]}`
}

export function CodingWorkspaceView({ view, role, userId, coders, providers, todayIso }: {
  view: WorkspaceView
  role: Role
  userId: number | null
  coders: { id: number; name: string }[]
  providers: { id: number; name: string }[]
  todayIso: string
}) {
  const { coding, encounter, patient } = view
  const finalised = coding.status === 'finalised'
  const holdsClaim = role === 'admin' || (userId !== null && coding.assignedToUserId === userId)
  const canEdit = !finalised && encounter.isCompleted && holdsClaim
  const canRaise = !finalised && encounter.isCompleted && codingActionAvailable(coding.status, 'raise_query', role)

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">{patient.name}</h1>
          <CodingStatusBadge status={coding.status} />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
          <div><dt className="text-xs text-muted-foreground">UHID</dt><dd className="font-mono">{patient.uhid ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Sex</dt><dd>{patient.sexLabel}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Age</dt><dd>{`${patient.ageYears} years`}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Visit</dt><dd>{`${encounter.typeLabel} · ${encounter.visitTypeLabel} · ${encounter.dateLabel}`}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Completed</dt><dd>{encounter.completedLabel ?? 'Not yet'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Department</dt><dd>{encounter.departmentName ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Doctor</dt><dd>{encounter.providerName}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Assigned to</dt><dd>{coding.assignedToName ?? 'Unclaimed'}</dd></div>
          {coding.codedLine && <div><dt className="text-xs text-muted-foreground">Coded</dt><dd>{coding.codedLine}</dd></div>}
          {coding.finalisedLine && <div><dt className="text-xs text-muted-foreground">Finalised</dt><dd>{coding.finalisedLine}</dd></div>}
        </dl>
        <CodingActions encounterId={view.encounterId} status={coding.status} role={role} assignedToUserId={coding.assignedToUserId} coders={coders} />
      </header>

      {finalised && (
        <div role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
          Coding is finalised and read-only. Reopen it, with a reason, to change any code.
        </div>
      )}
      {!encounter.isCompleted && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Coding starts once the visit is completed or the patient is discharged.
        </div>
      )}
      {!finalised && encounter.isCompleted && !holdsClaim && (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {coding.assignedToName ? `${coding.assignedToName} is coding this visit. ` : ''}Claim this encounter before changing its codes.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <CodingIssuesPanel issues={view.issues} />
          <EntryEditor kind="diagnosis" encounterId={view.encounterId} entries={view.diagnoses} canEdit={canEdit} encounterDate={encounter.dateIso} todayIso={todayIso} providers={providers} />
          <EntryEditor kind="procedure" encounterId={view.encounterId} entries={view.procedures} canEdit={canEdit} encounterDate={encounter.dateIso} todayIso={todayIso} providers={providers} />
          <CodingQueriesPanel
            encounterId={view.encounterId}
            queries={view.queries}
            providers={providers}
            defaultProviderId={encounter.providerId}
            canRaise={canRaise}
            canManage={!finalised}
          />
        </div>
        <div className="space-y-6">
          <section aria-labelledby="clinical-notes" className="space-y-3 rounded-lg border border-border p-4">
            <h2 id="clinical-notes" className="text-base font-semibold">Clinical notes (read-only, signed)</h2>
            {view.notes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No signed notes for this visit.</p>
            ) : view.notes.map((n) => (
              <article key={n.id} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <h3 className="text-sm font-medium">{n.title}</h3>
                <p className="text-xs text-muted-foreground">{n.byline}</p>
                <dl className="space-y-1.5 text-sm">
                  {n.sections.map((s) => (
                    <div key={s.label}>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</dt>
                      <dd className="whitespace-pre-wrap">{s.text}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </section>

          <section aria-labelledby="coding-history" className="space-y-2 rounded-lg border border-border p-4">
            <h2 id="coding-history" className="text-base font-semibold">Coding history</h2>
            {view.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No coding activity yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {view.events.map((e) => (
                  <li key={e.key}>
                    <p><span className="font-medium">{e.actionLabel}</span>{` · ${e.change}`}</p>
                    <p className="text-xs text-muted-foreground">{`${e.byName} · ${e.atLabel}`}</p>
                    {e.reason && <p className="whitespace-pre-wrap text-xs">{`Reason: `}<span>{e.reason}</span></p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
