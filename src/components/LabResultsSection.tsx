'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { OrderLabTestModal, type LabTestOption } from '@/components/OrderLabTestModal'
import { ImagingAttachmentStrip, type AttachmentView } from '@/components/ImagingAttachmentStrip'
import { LAB_STATUS_LABEL, PRE_RESULT_STATUSES, type LabOrderStatus } from '@/lib/labs/status' // SP5
// SP5: status chip, sample ID, quoted price, verification note; IST formatters (no toLocale*).
import { displaySampleId } from '@/lib/labs/sample-id'
import { formatPaise } from '@/lib/money'
import { formatDateTimeIn, formatIsoDate, istDateOf } from '@/lib/india-time'
import type { LabQuoteStatus } from '@/lib/labs/catalog'
// end SP5
import type { AnalyteResultRow } from '@/lib/queries/lab-result-values' // WS4 T10

export interface PatientLabOrder {
  id: number
  status: LabOrderStatus // SP5: widened to every lab_order_status value
  // Passed straight from the Server Component (listOrdersForPatient()) --
  // real Date instances via RSC's Flight protocol, matching LabWorklist's
  // WorklistOrder precedent, not JSON strings.
  orderedAt: Date
  collectedAt: Date | null
  testId: number
  testName: string
  testCode: string
  category: 'lab' | 'imaging'
  defaultUnit: string | null
  referenceRange: string | null
  attachments: AttachmentView[]
  result: {
    value: string
    unit: string | null
    referenceRange: string | null
    flag: 'normal' | 'abnormal' | 'critical'
    resultedByName: string
    resultedAt: Date
    notes: string | null
    /** WS4 T10: the per-analyte detail, in definition order (absent or [] for a single-value test). */
    analytes?: AnalyteResultRow[]
  } | null
  // SP5
  sampleId: string | null
  requisitionId: number | null
  quotedPricePaise: number | null
  quoteStatus: LabQuoteStatus
  verifiedByName: string | null
  verifiedAt: Date | null
  // end SP5
}

// SP5: the order's lifecycle stage as a chip, and its quoted price.
function StatusChip({ status }: { status: LabOrderStatus }) {
  return <span className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-foreground">{LAB_STATUS_LABEL[status]}</span>
}
const priceText = (o: { quotedPricePaise: number | null }) => (o.quotedPricePaise === null ? 'Not priced' : formatPaise(o.quotedPricePaise))

// Pill-with-text-label convention (BedBoard's STATUS_STYLES) -- the label
// text itself already satisfies "never color alone", no separate dot needed.
const FLAG_STYLES: Record<'normal' | 'abnormal' | 'critical', string> = {
  normal: 'border-border bg-secondary/50 text-muted-foreground',
  abnormal: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  // Same destructive-tone treatment as BedBoard's "blocked" room status.
  critical: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const FLAG_LABEL: Record<'normal' | 'abnormal' | 'critical', string> = {
  normal: 'Normal',
  abnormal: 'Abnormal',
  critical: 'Critical',
}

function FlagPill({ flag }: { flag: 'normal' | 'abnormal' | 'critical' }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${FLAG_STYLES[flag]}`}>
      {FLAG_LABEL[flag]}
    </span>
  )
}

// WS4 T10 (spec 3.7): an analyte test expands to a table of its analytes. The flag pill shows
// the severity (red "Critical" for critical) and the direction is spelled out next to it.
function analyteDirection(a: AnalyteResultRow): 'Low' | 'High' | null {
  if (a.flag === 'normal') return null
  if (a.interpretation === 'L' || a.interpretation === 'LL') return 'Low'
  if (a.interpretation === 'H' || a.interpretation === 'HH') return 'High'
  return null
}

function AnalyteTable({ testName, analytes }: { testName: string; analytes: AnalyteResultRow[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table aria-label={`Analytes of ${testName}`} className="w-full min-w-[28rem] text-left text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="py-1 pr-2 font-medium">Analyte</th>
            <th scope="col" className="py-1 pr-2 font-medium">Result</th>
            <th scope="col" className="py-1 pr-2 font-medium">Unit</th>
            <th scope="col" className="py-1 pr-2 font-medium">Reference range</th>
            <th scope="col" className="py-1 font-medium">Flag</th>
          </tr>
        </thead>
        <tbody>
          {analytes.map((a) => {
            const direction = analyteDirection(a)
            return (
              <tr key={a.analyteId} className="border-b border-border/60 last:border-0">
                <td className="py-1 pr-2 text-foreground">{a.name}</td>
                <td className={`py-1 pr-2 ${a.flag === 'normal' ? 'text-foreground' : 'font-semibold text-foreground'}`}>{a.value}</td>
                <td className="py-1 pr-2 text-muted-foreground">{a.unit ?? ''}</td>
                <td className="py-1 pr-2 text-muted-foreground">{a.referenceRange ?? ''}</td>
                <td className="py-1">
                  {a.flag !== 'normal' && (
                    <span className="inline-flex items-center gap-1">
                      <FlagPill flag={a.flag} />
                      {direction && <span className="text-[11px] text-muted-foreground">{direction}</span>}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
// end WS4 T10

// SP5: keyed by PRE_RESULT_STATUSES (every status before a result exists).
type PreResultStatus = (typeof PRE_RESULT_STATUSES)[number]
const PENDING_STATUS_LABEL: Record<PreResultStatus, string> = {
  ordered: LAB_STATUS_LABEL.ordered,
  scheduled: LAB_STATUS_LABEL.scheduled,
  collected: LAB_STATUS_LABEL.collected,
  received: LAB_STATUS_LABEL.received,
}
const isPreResult = (s: LabOrderStatus): s is PreResultStatus => (PRE_RESULT_STATUSES as readonly LabOrderStatus[]).includes(s)
// Statuses in which an order carries a result.
const HAS_RESULT_STATUSES: readonly LabOrderStatus[] = ['resulted', 'verified', 'reported']

export function LabResultsSection({ patientId, orders, labTests, canOrder }: { patientId: string; orders: PatientLabOrder[]; labTests: LabTestOption[]; canOrder: boolean }) {
  const [ordering, setOrdering] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set()) // WS4 T10
  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // Only treat an order as "resulted" once its labResults row is actually
  // present. The result write (SP5: recordLabResult) runs its status UPDATE and result INSERT in
  // one db.transaction, so new data cannot be half-written, but rows written
  // before that change could be a resulted-status order with no result row.
  // Keep degrading that legacy case to "Pending" instead of crashing the
  // whole Medical Record page on a non-null result.
  const resulted = orders
    .filter(
      (o): o is PatientLabOrder & { result: NonNullable<PatientLabOrder['result']> } =>
        HAS_RESULT_STATUSES.includes(o.status) && o.result !== null
    )
    // Newest-first by when the order was resulted (spec §6), not by orderedAt.
    .sort((a, b) => b.result.resultedAt.getTime() - a.result.resultedAt.getTime())
  const pending = orders.filter(
    (o) => isPreResult(o.status) || (HAS_RESULT_STATUSES.includes(o.status) && o.result === null)
  )

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lab Results</h2>
        {canOrder && <Button size="sm" onClick={() => setOrdering(true)}>Order labs</Button>}
      </div>

      {resulted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No lab results recorded.</p>
      ) : (
        <ul className="space-y-2">
          {resulted.map((o) => {
            const r = o.result
            const analytes = r.analytes ?? [] // WS4 T10
            const open = expanded.has(o.id)
            return (
              <li key={`lab-${o.id}`} className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {o.testName} <span className="font-normal text-muted-foreground">({o.testCode})</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.value}{r.unit ? ` ${r.unit}` : ''}
                      {r.referenceRange && ` · Reference: ${r.referenceRange}`}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Resulted {formatDateTimeIn(r.resultedAt)} by {r.resultedByName}
                    </p>
                    {/* SP5 */}
                    {o.status === 'resulted' && <p className="mt-0.5 text-xs font-medium text-warning">Preliminary: awaiting verification</p>}
                    {o.verifiedAt && o.verifiedByName && (
                      <p className="mt-0.5 text-xs text-muted-foreground">Verified {formatDateTimeIn(o.verifiedAt)} by {o.verifiedByName}</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {o.sampleId ? `Sample ${displaySampleId(o.sampleId)} · ` : ''}{priceText(o)}
                    </p>
                    {r.notes && <p className="mt-1 text-xs text-muted-foreground">{r.notes}</p>}
                    {analytes.length > 0 && (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggle(o.id)}
                        className="mt-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {open ? 'Hide analytes' : `Show ${analytes.length} analytes`}
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusChip status={o.status} />
                    <FlagPill flag={r.flag} />
                  </div>
                </div>
                {open && analytes.length > 0 && <AnalyteTable testName={o.testName} analytes={analytes} />}
                <ImagingAttachmentStrip attachments={o.attachments} />
              </li>
            )
          })}
        </ul>
      )}

      {pending.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pending</p>
          <ul className="space-y-1.5">
            {pending.map((o) => (
              <li key={`lab-pending-${o.id}`} className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {o.testName} <span className="text-xs">({o.testCode})</span>
                  </span>
                  <span className="text-xs">
                    {isPreResult(o.status) ? PENDING_STATUS_LABEL[o.status] : LAB_STATUS_LABEL[o.status]} · {formatIsoDate(istDateOf(o.orderedAt))}
                    {o.sampleId ? ` · ${displaySampleId(o.sampleId)}` : ''} · {priceText(o)}
                  </span>
                </div>
                <ImagingAttachmentStrip attachments={o.attachments} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {ordering && <OrderLabTestModal patientId={patientId} labTests={labTests} onClose={() => setOrdering(false)} />}
    </div>
  )
}
