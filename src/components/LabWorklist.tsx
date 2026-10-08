'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { EnterLabResultModal } from '@/components/EnterLabResultModal'
import { AttachImagingModal } from '@/components/AttachImagingModal'
import { ImagingAttachmentStrip, type AttachmentView } from '@/components/ImagingAttachmentStrip'
import type { Role } from '@/lib/auth'
import { LAB_STATUS_LABEL, PRE_RESULT_STATUSES, type LabOrderStatus } from '@/lib/labs/status' // SP5
// SP5: stage-based worklist
import Link from 'next/link'
import { ReceiveSampleForm } from '@/components/labs/ReceiveSampleForm'
import { displaySampleId } from '@/lib/labs/sample-id'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import { LAB_COLLECT_ROLES, LAB_ORDER_ROLES, LAB_RECEIVE_ROLES, LAB_REPORT_READ_ROLES, LAB_REPORT_RELEASE_ROLES, LAB_RESULT_ENTRY_ROLES, LAB_VERIFY_ROLES } from '@/lib/role-policy'
import { ReleaseReportButton, type ReleasedReport } from '@/components/labs/ReleaseReportButton'
// end SP5

export interface WorklistOrder {
  id: number
  status: LabOrderStatus // SP5: widened to every lab_order_status value
  // Passed straight from the Server Component (listWorklist()) without a
  // JSON round-trip, so these arrive as real Date instances (RSC's Flight
  // protocol serializes Date natively) rather than ISO strings -- unlike
  // components fed by a client-side fetch(), which get JSON strings.
  orderedAt: Date
  collectedAt: Date | null
  patientId: string
  patientName: string
  testId: number
  testName: string
  testCode: string
  category: 'lab' | 'imaging'
  attachments: AttachmentView[]
  orderedByProviderId: number
  orderedByProviderName: string
  // SP5: stage data (WorklistRow in src/lib/queries/lab-orders.ts)
  sampleId: string | null
  requisitionId: number | null
  homeCollectionVisitId: number | null
  visitDate: string | null
  receivedAt: Date | null
  verifiedAt: Date | null
  patientUhid: string | null
  result: { value: string; unit: string | null; referenceRange?: string | null; notes?: string | null; flag: 'normal' | 'abnormal' | 'critical'; resultedByName: string; amendedAt: Date | null } | null
  // end SP5
}

export interface LabTestOption {
  id: number
  name: string
  code: string
  defaultUnit: string | null
  referenceRange: string | null
}

// Same dot + plain-text-label convention as StatusChip/AssignmentStatusChip/
// MedStatusPill -- kept local since lab-order status isn't any of those
// components' domain.
// SP5: one entry per lab_order_status value; labels come from LAB_STATUS_LABEL, so a legacy
// `resulted` order reads "Awaiting verification" (Ruling 5).
const STATUS_CONFIG: Record<LabOrderStatus, { label: string; dotClassName: string; textClassName: string }> = {
  ordered: { label: LAB_STATUS_LABEL.ordered, dotClassName: 'bg-primary', textClassName: 'text-foreground' },
  scheduled: { label: LAB_STATUS_LABEL.scheduled, dotClassName: 'bg-primary', textClassName: 'text-foreground' },
  collected: { label: LAB_STATUS_LABEL.collected, dotClassName: 'bg-warning', textClassName: 'text-warning' },
  received: { label: LAB_STATUS_LABEL.received, dotClassName: 'bg-warning', textClassName: 'text-warning' },
  resulted: { label: LAB_STATUS_LABEL.resulted, dotClassName: 'bg-warning', textClassName: 'text-warning' },
  verified: { label: LAB_STATUS_LABEL.verified, dotClassName: 'bg-success', textClassName: 'text-success' },
  reported: { label: LAB_STATUS_LABEL.reported, dotClassName: 'bg-success', textClassName: 'text-success' },
  cancelled: { label: LAB_STATUS_LABEL.cancelled, dotClassName: 'bg-muted-foreground', textClassName: 'text-muted-foreground' },
}

function LabStatusPill({ status }: { status: WorklistOrder['status'] }) {
  const { label, dotClassName, textClassName } = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}

interface CancelDraft { id: number; reason: string }
interface RowError { id: number; message: string }

const FLAG_LABEL: Record<'normal' | 'abnormal' | 'critical', string> = { normal: 'Normal', abnormal: 'Abnormal', critical: 'Critical' }
const FLAG_CLASS: Record<'normal' | 'abnormal' | 'critical', string> = {
  normal: 'text-muted-foreground',
  abnormal: 'text-warning',
  critical: 'text-destructive',
}
const isPreResult = (s: LabOrderStatus) => (PRE_RESULT_STATUSES as readonly LabOrderStatus[]).includes(s)

interface Caps {
  canCollect: boolean
  canResult: boolean
  canVerify: boolean
  canCancel: boolean
  canAttachImaging: boolean
}

// Hoisted to module scope (not a closure inside LabWorklist) so it isn't
// re-created on every render -- all per-row behavior comes in as props.
function LabRow({
  order,
  caps,
  busyId,
  rowError,
  cancelFor,
  onMarkCollected,
  onOpenResult,
  onVerify,
  onOpenAttach,
  onStartCancel,
  onCancelReasonChange,
  onCancelBack,
  onConfirmCancel,
}: {
  order: WorklistOrder
  caps: Caps
  busyId: number | null
  rowError: RowError | null
  cancelFor: CancelDraft | null
  onMarkCollected: (id: number) => void
  onOpenResult: (order: WorklistOrder) => void
  onVerify: (id: number) => void
  onOpenAttach: (order: WorklistOrder) => void
  onStartCancel: (id: number) => void
  onCancelReasonChange: (reason: string) => void
  onCancelBack: () => void
  onConfirmCancel: () => void
}) {
  const o = order
  const busy = busyId === o.id
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {o.patientName}
            {o.patientUhid && <span className="font-normal text-muted-foreground"> ({o.patientUhid})</span>}
            <span className="font-normal text-muted-foreground"> — {o.testName} ({o.testCode})</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Ordered by {o.orderedByProviderName} on {formatDateTimeIn(o.orderedAt)}
            {o.collectedAt && ` · Collected ${formatDateTimeIn(o.collectedAt)}`}
            {o.receivedAt && ` · Received ${formatDateTimeIn(o.receivedAt)}`}
            {o.verifiedAt && ` · Verified ${formatDateTimeIn(o.verifiedAt)}`}
          </p>
          {o.sampleId && <p className="font-mono text-xs text-foreground">Sample {displaySampleId(o.sampleId)}</p>}
          {o.status === 'scheduled' && o.visitDate && (
            <span className="mt-1 inline-flex rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-[11px] font-medium text-foreground">
              Home visit {formatIsoDate(o.visitDate)}
            </span>
          )}
          {o.result && (o.status === 'resulted' || o.status === 'verified' || o.status === 'reported') && (
            <p className="text-xs text-foreground">
              {o.result.value}{o.result.unit ? ` ${o.result.unit}` : ''}
              {' · '}<span className={FLAG_CLASS[o.result.flag]}>{FLAG_LABEL[o.result.flag]}</span>
              {' · '}by {o.result.resultedByName}{o.result.amendedAt ? ' (amended)' : ''}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <LabStatusPill status={o.status} />
          {o.status === 'ordered' && caps.canCollect && (
            <Button size="xs" onClick={() => onMarkCollected(o.id)} disabled={busy}>Mark collected</Button>
          )}
          {o.status === 'received' && caps.canResult && (
            <Button size="xs" onClick={() => onOpenResult(o)} disabled={busy}>Enter result</Button>
          )}
          {o.status === 'resulted' && caps.canResult && (
            <Button size="xs" variant="outline" onClick={() => onOpenResult(o)} disabled={busy}>Amend</Button>
          )}
          {o.status === 'resulted' && caps.canVerify && (
            <Button size="xs" onClick={() => onVerify(o.id)} disabled={busy}>Verify</Button>
          )}
          {o.sampleId && (o.status === 'collected' || o.status === 'scheduled') && (
            <Link href={`/lab-labels?orders=${o.id}`} className="text-xs font-medium text-primary hover:underline">Print label</Link>
          )}
          {isPreResult(o.status) && caps.canCancel && (
            <Button size="xs" variant="destructive" onClick={() => onStartCancel(o.id)} disabled={busy}>Cancel</Button>
          )}
          {o.category === 'imaging' && isPreResult(o.status) && o.status !== 'scheduled' && caps.canAttachImaging && (
            <Button size="xs" variant="outline" onClick={() => onOpenAttach(o)} disabled={busy}>Attach image</Button>
          )}
        </div>
      </div>
      <ImagingAttachmentStrip attachments={o.attachments} />
      {cancelFor?.id === o.id && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={cancelFor.reason}
            onChange={(e) => onCancelReasonChange(e.target.value)}
            placeholder="Reason for cancelling (required)"
            aria-label="Cancel reason"
            className="min-w-[12rem] flex-1 rounded-md border border-border px-3 py-1.5 text-sm"
          />
          <Button size="xs" variant="outline" onClick={onCancelBack}>Back</Button>
          <Button size="xs" variant="destructive" onClick={onConfirmCancel} disabled={!cancelFor.reason.trim() || busy}>Confirm cancel</Button>
        </div>
      )}
      {rowError?.id === o.id && <p role="alert" className="mt-2 text-xs text-destructive">{rowError.message}</p>}
    </div>
  )
}

// SP5: what happened to the doctor's follow-up request when the report was released.
function followUpNote(f: ReleasedReport['followUp']): string {
  switch (f.outcome) {
    case 'created': return f.dueDate ? `Follow-up visit planned for ${formatIsoDate(f.dueDate)}.` : 'Follow-up visit planned.'
    case 'linked': return 'Linked to the patient\'s upcoming follow-up visit.'
    case 'pending': return 'The follow-up visit will be planned once every test is reported.'
    case 'failed': return 'The follow-up visit could not be planned automatically; please plan it from the chart.'
    default: return ''
  }
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title} ({count})</h2>
      {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : children}
    </section>
  )
}

export function LabWorklist({ orders, labTests, role }: { orders: WorklistOrder[]; labTests: LabTestOption[]; role: Role }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<number | null>(null)
  const [rowError, setRowError] = useState<RowError | null>(null)
  const [cancelFor, setCancelFor] = useState<CancelDraft | null>(null)
  const [resultFor, setResultFor] = useState<WorklistOrder | null>(null)
  const [attachFor, setAttachFor] = useState<WorklistOrder | null>(null)
  const [collectedNotice, setCollectedNotice] = useState<{ id: number; sampleId: string } | null>(null)
  const [releasedNotice, setReleasedNotice] = useState<ReleasedReport | null>(null)

  // SP5 role split (src/lib/role-policy.ts): labs enters results, pi verifies, only the
  // ordering clinicians cancel; frontdesk and collector have no worklist actions.
  const caps: Caps = {
    canCollect: LAB_COLLECT_ROLES.includes(role),
    canResult: LAB_RESULT_ENTRY_ROLES.includes(role),
    canVerify: LAB_VERIFY_ROLES.includes(role),
    canCancel: LAB_ORDER_ROLES.includes(role),
    canAttachImaging: LAB_COLLECT_ROLES.includes(role),
  }
  const canReceive = LAB_RECEIVE_ROLES.includes(role)
  const canRelease = LAB_REPORT_RELEASE_ROLES.includes(role)
  const canReadReports = LAB_REPORT_READ_ROLES.includes(role)

  const byStatus = (...statuses: LabOrderStatus[]) => orders.filter((o) => statuses.includes(o.status))
  const toCollect = byStatus('ordered', 'scheduled')
  const inTransit = byStatus('collected')
  const atBench = byStatus('received')
  const toVerify = byStatus('resulted')
  const toReport = byStatus('verified')
  const reported = byStatus('reported')
  const cancelled = byStatus('cancelled')

  // To report is grouped by requisition: the report is released per requisition.
  const reportGroups = new Map<string, WorklistOrder[]>()
  for (const o of toReport) {
    const key = o.requisitionId === null ? 'none' : String(o.requisitionId)
    reportGroups.set(key, [...(reportGroups.get(key) ?? []), o])
  }

  // Shared client fetch helper: a failure is always shown, with the route's own 400/404/409
  // text or a fixed message (never server internals).
  async function post(id: number, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusyId(id)
    setRowError(null)
    const res = await sendJson<Record<string, unknown> | null>(`/api/lab-orders/${id}/${path}`, 'POST', body)
    setBusyId(null)
    if (res.ok) return res.data ?? {}
    setRowError({ id, message: res.error })
    return null
  }

  async function markCollected(id: number) {
    const body = await post(id, 'collect')
    if (!body) return
    if (typeof body.sampleId === 'string') setCollectedNotice({ id, sampleId: body.sampleId })
    router.refresh()
  }

  async function verify(id: number) {
    if (await post(id, 'verify')) router.refresh()
  }

  async function confirmCancel() {
    if (!cancelFor || !cancelFor.reason.trim()) return
    const ok = await post(cancelFor.id, 'cancel', { reason: cancelFor.reason })
    if (ok) { setCancelFor(null); router.refresh() }
  }

  function testDefaults(testId: number) {
    return labTests.find((t) => t.id === testId) ?? null
  }

  const rowProps = {
    caps,
    busyId,
    rowError,
    cancelFor,
    onMarkCollected: markCollected,
    onOpenResult: setResultFor,
    onVerify: verify,
    onOpenAttach: setAttachFor,
    onStartCancel: (id: number) => setCancelFor({ id, reason: '' }),
    onCancelReasonChange: (reason: string) => setCancelFor((prev) => (prev ? { ...prev, reason } : prev)),
    onCancelBack: () => setCancelFor(null),
    onConfirmCancel: confirmCancel,
  }
  const rows = (list: WorklistOrder[]) => <div className="space-y-2">{list.map((o) => <LabRow key={o.id} order={o} {...rowProps} />)}</div>

  return (
    <div className="space-y-8">
      {collectedNotice && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm">
          <span>Sample <span className="font-mono font-semibold">{displaySampleId(collectedNotice.sampleId)}</span> collected.</span>
          <Link href={`/lab-labels?orders=${collectedNotice.id}`} className="font-medium text-primary hover:underline">Print label</Link>
          <button type="button" onClick={() => setCollectedNotice(null)} className="ml-auto text-xs text-muted-foreground hover:underline">Dismiss</button>
        </div>
      )}

      {releasedNotice && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm">
          <span>
            Report <span className="font-mono font-semibold">{releasedNotice.report.reportNumber}</span>
            {releasedNotice.report.version > 1 ? ` (version ${releasedNotice.report.version})` : ''} released.
            {' '}{followUpNote(releasedNotice.followUp)}
          </span>
          {canReadReports && (
            <a href={`/api/lab-reports/${releasedNotice.report.id}/download`} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Open report</a>
          )}
          <button type="button" onClick={() => setReleasedNotice(null)} className="ml-auto text-xs text-muted-foreground hover:underline">Dismiss</button>
        </div>
      )}

      <Section title="To collect" count={toCollect.length} empty="No orders awaiting collection.">{rows(toCollect)}</Section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">In transit ({inTransit.length})</h2>
        {canReceive && <ReceiveSampleForm />}
        {inTransit.length === 0 ? <p className="text-sm text-muted-foreground">No samples on their way to the lab.</p> : rows(inTransit)}
      </section>

      <Section title="At the bench" count={atBench.length} empty="No samples awaiting results.">{rows(atBench)}</Section>
      <Section title="To verify" count={toVerify.length} empty="No results awaiting verification.">{rows(toVerify)}</Section>

      <Section title="To report" count={toReport.length} empty="No verified results awaiting a report.">
        <div className="space-y-4">
          {[...reportGroups.entries()].map(([key, list]) => (
            <div key={key}>
              <div className="mb-1 flex flex-wrap items-center gap-3">
                <p className="text-xs font-medium text-muted-foreground">{key === 'none' ? 'No requisition' : `Requisition #${key}`}</p>
                {canRelease && key !== 'none' && (
                  <ReleaseReportButton requisitionId={Number(key)} onReleased={(r) => { setReleasedNotice(r); router.refresh() }} />
                )}
              </div>
              {rows(list)}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Reported" count={reported.length} empty="No reported results yet.">{rows(reported)}</Section>

      {cancelled.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer font-medium">{cancelled.length} cancelled</summary>
          <div className="mt-2 opacity-60">{rows(cancelled)}</div>
        </details>
      )}

      {resultFor && (
        <EnterLabResultModal
          orderId={resultFor.id}
          testName={resultFor.testName}
          defaultUnit={testDefaults(resultFor.testId)?.defaultUnit ?? null}
          defaultReferenceRange={testDefaults(resultFor.testId)?.referenceRange ?? null}
          category={resultFor.category}
          attachments={resultFor.attachments}
          // Amend: prefill the current result so a correction never blanks a field.
          initial={resultFor.status === 'resulted' && resultFor.result ? resultFor.result : null}
          onClose={() => setResultFor(null)}
        />
      )}

      {attachFor && (
        <AttachImagingModal
          orderId={attachFor.id}
          testName={attachFor.testName}
          onClose={() => setAttachFor(null)}
        />
      )}
    </div>
  )
}
