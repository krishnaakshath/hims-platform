'use client'
import { sendJson } from '@/lib/client-fetch'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
// SP5: multi-test order (one requisition) plus an optional follow-up request.
import { INTERVAL_UNITS, type IntervalUnit } from '@/lib/follow-ups/rules'
import { followUpIntervalSchema, followUpReasonSchema } from '@/lib/follow-ups/validation'
// end SP5
// WS2 T10: priority, notes, fasting, prices, the order's charges and booking the home visit.
import { LAB_CLINICAL_NOTES_MAX, LAB_ORDER_PRIORITIES, type LabOrderPriority } from '@/lib/labs/validation'
import type { AutoChargeOutcome } from '@/lib/queries/auto-charge'
import { formatPaise } from '@/lib/money'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'
import { BookHomeCollectionModal } from '@/components/home-collection/BookHomeCollectionModal'
// end WS2 T10

export interface LabTestOption {
  id: number
  name: string
  code: string
  defaultUnit: string | null
  referenceRange: string | null
  category: 'lab' | 'imaging'
  // Foundations T10: null = no tariff service, so the test has no price and cannot be ordered.
  serviceId: number | null
  isActive: boolean
  // Foundations T10: false when the mapped service is inactive or has no current rate.
  priced: boolean
  // WS2 T10: the current list (base) price, for display; the order route prices the line itself.
  pricePaise?: number | null
  // WS2 T10 (ruling R3): an order of this test defaults to "fasting required".
  fastingRequired?: boolean
}

/** WS2 T10: what the order route answered (201). */
export interface PlacedLabOrder {
  requisitionId: number
  lines: { orderId: number; labTestId: number }[]
  charges: AutoChargeOutcome[]
  patientIsLocal: boolean
  includesLabTest: boolean
  homeCollectionEligible: boolean
}

// SP5 messages shown after the order is placed (Ruling 3: local = registered PIN in the service area).
const LOCAL_MESSAGE = 'Home collection available for this patient'
const NOT_LOCAL_MESSAGE = 'Patient is outside the home-collection area: walk-in only'
const FIELD = 'w-full rounded-md border border-border px-3 py-2 text-sm'

const PRIORITY_LABEL: Record<LabOrderPriority, string> = { routine: 'Routine', urgent: 'Urgent', stat: 'STAT' }
const NOT_BILLED_REASON: Record<Extract<AutoChargeOutcome, { ok: false }>['reason'], string> = {
  no_context: 'no visit or stay to bill',
  context_cancelled: 'the visit is cancelled',
  no_service: 'no billing service',
  price_unresolved: 'no rate',
  blocked: 'a billing rule blocked it',
}
const billToLabel = (b: 'self' | 'payer') => (b === 'payer' ? 'Insurer' : 'Self')
const orderable = (t: LabTestOption) => t.serviceId !== null && t.isActive && t.priced

/**
 * WS2 T10: the order form, shared by the chart's modal and the workspace Orders panel.
 * `layout: 'tabs'` shows lab and imaging tests on two tabs; 'groups' lists both.
 */
export function LabOrderForm({ patientId, labTests, originatingEncounterId, billTo, layout = 'groups', onPlaced, onCancel }: {
  patientId: string
  labTests: LabTestOption[]
  originatingEncounterId?: number
  billTo?: 'self' | 'payer'
  layout?: 'groups' | 'tabs'
  onPlaced: (placed: PlacedLabOrder, orderedTestIds: number[]) => void
  onCancel?: () => void
}) {
  const id = useId()
  const [selected, setSelected] = useState<number[]>([])
  const [tab, setTab] = useState<'lab' | 'imaging'>('lab')
  const [priority, setPriority] = useState<LabOrderPriority>('routine')
  const [clinicalNotes, setClinicalNotes] = useState('')
  const [fasting, setFasting] = useState(false)
  const [fastingTouched, setFastingTouched] = useState(false)
  const [askFollowUp, setAskFollowUp] = useState(false)
  const [intervalValue, setIntervalValue] = useState('2')
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('weeks')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('') // WS4 T13

  function toggle(testId: number) {
    const next = selected.includes(testId) ? selected.filter((x) => x !== testId) : [...selected, testId]
    setSelected(next)
    // Ruling R3: pre-tick fasting while the user has not chosen it themselves.
    if (!fastingTouched) setFasting(labTests.some((t) => next.includes(t.id) && t.fastingRequired === true))
  }

  async function submit() {
    setError(null)
    let followUp: { interval: { value: number; unit: IntervalUnit }; reason: string } | null = null
    if (askFollowUp) {
      const interval = followUpIntervalSchema.safeParse({ value: Number(intervalValue), unit: intervalUnit })
      if (!interval.success) { setError('Enter a follow-up interval between 1 and 365 (within 2 years).'); return }
      const why = followUpReasonSchema.safeParse(reason)
      if (!why.success) { setError(reason.trim() ? 'The follow-up reason is too long.' : 'Enter a short reason for the follow-up visit.'); return }
      followUp = { interval: { value: interval.data.value, unit: interval.data.unit as IntervalUnit }, reason: why.data }
    }
    // Catalog order, so the request (and the requisition's lines) read like the checklist.
    const labTestIds = labTests.filter((t) => selected.includes(t.id) && orderable(t)).map((t) => t.id)
    const notes = clinicalNotes.trim()
    const body = {
      labTestIds, followUp, priority, fastingRequired: fasting,
      ...(notes ? { clinicalNotes: notes } : {}),
      ...(originatingEncounterId !== undefined ? { originatingEncounterId } : {}),
    }
    setSubmitting(true)
    const res = await sendJson<Partial<PlacedLabOrder> | null>(`/api/patients/${patientId}/lab-orders`, 'POST', body)
    setSubmitting(false)
    if (res.ok) {
      const d = res.data ?? {}
      // SP5: imaging is never home-collected, so an imaging-only order gets no home-collection line.
      const includesLabTest = labTests.some((t) => labTestIds.includes(t.id) && t.category === 'lab')
      onPlaced({
        requisitionId: d.requisitionId ?? 0, lines: d.lines ?? [], charges: d.charges ?? [], patientIsLocal: d.patientIsLocal === true,
        includesLabTest, homeCollectionEligible: d.homeCollectionEligible === true,
      }, labTestIds)
      return
    }
    setError(res.error)
  }

  const chosen = labTests.filter((t) => selected.includes(t.id))
  const count = chosen.length
  const total = chosen.reduce((sum, t) => sum + (t.pricePaise ?? 0), 0)
  const canSubmit = count > 0 && !submitting
  // WS4 T13: the typed text narrows the list by name or code; ticked tests stay ticked when hidden.
  const q = query.trim().toLowerCase()
  const visible = q ? labTests.filter((t) => t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)) : labTests
  const labOptions = visible.filter((t) => t.category === 'lab')
  const imagingOptions = visible.filter((t) => t.category === 'imaging')

  const options = (list: LabTestOption[]) => list.map((t) => {
    const unpriced = t.serviceId === null || !t.priced
    const off = unpriced || !t.isActive
    return (
      <label key={t.id} className={`flex items-center gap-2 text-sm ${off ? 'text-muted-foreground' : ''}`}>
        <input type="checkbox" checked={selected.includes(t.id)} disabled={off} onChange={() => toggle(t.id)} />
        <span>{t.name} ({t.code})</span>
        {unpriced && <span className="text-xs">No price: ask billing</span>}
        {!unpriced && t.pricePaise != null && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatPaise(t.pricePaise)}</span>}
      </label>
    )
  })
  const group = (legend: string, list: LabTestOption[]) =>
    list.length > 0 && (
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{legend}</legend>
        {options(list)}
      </fieldset>
    )

  return (
    <div className="space-y-3">
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {/* WS4 T13 */}
        {labTests.length > 0 && (
          <input type="search" aria-label="Search tests" placeholder="Search tests by name or code" value={query}
            onChange={(e) => setQuery(e.target.value)} className={FIELD} />
        )}
        {layout === 'tabs' ? (
          <div>
            <div role="tablist" aria-label="Order type" className="mb-2 flex gap-1">
              {(['lab', 'imaging'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={`rounded-md px-3 py-1 text-sm ${tab === k ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground'}`}>
                  {k === 'lab' ? 'Lab' : 'Imaging'}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="space-y-1">
              {options(tab === 'lab' ? labOptions : imagingOptions)}
              {(tab === 'lab' ? labOptions : imagingOptions).length === 0 && <p className="text-sm text-muted-foreground">No tests of this kind in the catalog.</p>}
            </div>
          </div>
        ) : (
          <>
            {group('Laboratory', labOptions)}
            {group('Imaging & diagnostics', imagingOptions)}
            {q && labTests.length > 0 && visible.length === 0 && <p className="text-sm text-muted-foreground">No tests match your search.</p>}
          </>
        )}
        {labTests.length === 0 && <p className="text-sm text-warning">No lab tests are available in the catalog.</p>}

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`${id}-priority`} className="block text-xs text-muted-foreground">Priority</label>
            <select id={`${id}-priority`} value={priority} onChange={(e) => setPriority(e.target.value as LabOrderPriority)} className={`${FIELD} !w-32`}>
              {LAB_ORDER_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={fasting} onChange={(e) => { setFastingTouched(true); setFasting(e.target.checked) }} />
            <span>Fasting required</span>
          </label>
        </div>
        <div>
          <label htmlFor={`${id}-notes`} className="block text-xs text-muted-foreground">Clinical notes for the lab (optional)</label>
          <textarea id={`${id}-notes`} value={clinicalNotes} onChange={(e) => setClinicalNotes(e.target.value)} maxLength={LAB_CLINICAL_NOTES_MAX} rows={2} className={FIELD} />
        </div>

        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={askFollowUp} onChange={(e) => setAskFollowUp(e.target.checked)} />
              <span>Ask for a follow-up visit after the report</span>
            </label>
          </legend>
          {askFollowUp && (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label htmlFor={`${id}-value`} className="block text-xs text-muted-foreground">Follow-up after</label>
                  <input id={`${id}-value`} type="number" min={1} max={365} value={intervalValue} onChange={(e) => setIntervalValue(e.target.value)} className={FIELD} />
                </div>
                <div>
                  <label htmlFor={`${id}-unit`} className="block text-xs text-muted-foreground">Unit</label>
                  <select id={`${id}-unit`} value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className={`${FIELD} !w-28`}>
                    {INTERVAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor={`${id}-reason`} className="block text-xs text-muted-foreground">Reason (shown to front desk and in patient reminders)</label>
                <input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD} />
              </div>
            </>
          )}
        </fieldset>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      {(count > 0 || billTo) && (
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          {count > 0 ? <span className="font-medium tabular-nums">{`Total ${formatPaise(total)}`}</span> : <span />}
          {billTo && <span className="text-muted-foreground">{`Billed to: ${billToLabel(billTo)}`}</span>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button onClick={submit} disabled={!canSubmit}>{count === 0 ? 'Order tests' : `Order ${count} test${count === 1 ? '' : 's'}`}</Button>
      </div>
    </div>
  )
}

/** WS2 T10: what the order put on the bill, what it did not, and the home-collection line. */
export function LabOrderPlacedSummary({ placed, onBook }: { placed: PlacedLabOrder; onBook?: () => void }) {
  const billed = placed.charges.filter((c): c is Extract<AutoChargeOutcome, { ok: true }> => c.ok)
  const notBilled = placed.charges.filter((c): c is Extract<AutoChargeOutcome, { ok: false }> => !c.ok)
  const reasons = [...new Set(notBilled.map((c) => c.reason))]
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Tests ordered.</p>
      {billed.length > 0 && (
        <ul className="space-y-0.5 text-sm">
          {billed.map((c) => (
            <li key={c.lineId}>{`${c.itemName} ${formatPaise(c.taxablePaise)} on the bill (${c.billTo === 'payer' ? 'insurer' : 'self-pay'})`}</li>
          ))}
        </ul>
      )}
      {reasons.map((r) => {
        const n = notBilled.filter((c) => c.reason === r).length
        return <p key={r} className="text-sm text-warning">{`${n} test${n === 1 ? '' : 's'} not billed: ${NOT_BILLED_REASON[r]}`}</p>
      })}
      {placed.includesLabTest && <p role="status" className="text-sm">{placed.patientIsLocal ? LOCAL_MESSAGE : NOT_LOCAL_MESSAGE}</p>}
      {placed.homeCollectionEligible && onBook && <Button size="sm" variant="outline" onClick={onBook}>Book home collection</Button>}
    </div>
  )
}

// Reusable from any patient-chart context -- the caller (LabResultsSection's
// "Order Test" button) owns the trigger button and open/close state and
// passes this patient's id plus the test catalog (fetched server-side via
// listLabTests(), the same "prop-drilled reference data" shape as
// TransferAdmissionModal's `availableRooms`) as props.
export function OrderLabTestModal({ patientId, labTests, onClose, originatingEncounterId, billTo }: {
  patientId: string
  labTests: LabTestOption[]
  onClose: () => void
  /** WS2 T10: the visit the order is placed from (billed to it unless the patient is admitted). */
  originatingEncounterId?: number
  /** WS2 T10: shown as "Billed to: Self/Insurer" before ordering, when the caller knows it. */
  billTo?: 'self' | 'payer'
}) {
  const router = useRouter()
  const [placed, setPlaced] = useState<PlacedLabOrder | null>(null)
  const [booking, setBooking] = useState(false)

  if (placed && booking) {
    return (
      <BookHomeCollectionModal
        date={todayIsoIn(DEFAULT_TIMEZONE)}
        initialPatient={patientId}
        initialOrderIds={placed.lines.map((l) => l.orderId)}
        onClose={onClose}
      />
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Order Lab Tests</DialogTitle>
        </DialogHeader>
        {placed ? (
          <div className="space-y-3">
            <LabOrderPlacedSummary placed={placed} onBook={() => setBooking(true)} />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <LabOrderForm
            patientId={patientId}
            labTests={labTests}
            originatingEncounterId={originatingEncounterId}
            billTo={billTo}
            onCancel={onClose}
            onPlaced={(p) => { setPlaced(p); router.refresh() }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
