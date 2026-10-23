import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/http'
import { formatCalendarDate, formatIstDateTime } from '@/lib/india-time'
import {
  CHECKLIST_LABEL,
  DATA_PRINCIPAL_CHECKLIST_KEYS,
  KIND_LABEL,
  STATUS_LABEL,
  VIA_LABEL,
  getDataPrincipalRequest,
  type DataPrincipalRequestStatus,
} from '@/lib/queries/data-principal-requests'
import { DataRequestActions } from '@/components/governance/DataRequestActions'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

// WS8 T14 (spec D18): one data-principal request -- details, checklist, status, export and erasure.
// Admin only.
export default async function DataRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (session.role !== 'admin') redirect('/')

  const id = parseId((await params).id)
  if (id === null) notFound()
  const r = await getDataPrincipalRequest(id)
  if (!r) notFound()
  await logAudit(session, 'viewed data-principal request', r.patientId, `request=${id}`)

  const rows: [string, React.ReactNode][] = [
    ['Patient UHID', r.patientId ? (
      <Link key="p" href={`/patients/${encodeURIComponent(r.patientId)}`} className="text-primary underline-offset-4 hover:underline">{r.patientUhid ?? 'No UHID'}</Link>
    ) : 'Chart erased'],
    ['Patient', r.patientName ? `${r.patientName}${r.patientArchived ? ' (archived)' : ''}` : '—'],
    ['Request', KIND_LABEL[r.kind]],
    ['Received', `${formatCalendarDate(r.receivedAt)} by ${VIA_LABEL[r.receivedVia].toLowerCase()}`],
    ['Due by', <span key="d">{formatCalendarDate(r.dueBy)}{r.overdue && <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">Overdue</span>}</span>],
    ['Status', STATUS_LABEL[r.status]],
    ['Closed', r.closedAt ? formatIstDateTime(r.closedAt) : '—'],
    ['Last handled by', r.handledByName ?? '—'],
    ['Note', r.note ?? '—'],
  ]

  return (
    <div className="space-y-4">
      <div>
        <Link href="/governance/data-requests" className="text-sm text-muted-foreground hover:text-foreground">Data requests</Link>
        <h1 className="text-2xl font-bold text-foreground">{r.reference}</h1>
      </div>
      <div className={SECTION}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={SECTION}>
        <DataRequestActions
          id={r.id}
          kind={r.kind}
          status={r.status}
          closed={r.closedAt !== null}
          hasPatient={r.patientId !== null}
          hasExport={r.hasExport}
          patientUhid={r.patientUhid}
          checklist={r.checklist as Record<string, boolean>}
          checklistItems={DATA_PRINCIPAL_CHECKLIST_KEYS.map((key) => ({ key, label: CHECKLIST_LABEL[key] }))}
          statusOptions={(Object.keys(STATUS_LABEL) as DataPrincipalRequestStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] }))}
          decisionNote={r.decisionNote}
        />
      </div>
    </div>
  )
}
