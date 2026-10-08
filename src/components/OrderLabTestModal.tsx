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

export interface LabTestOption {
  id: number
  name: string
  code: string
  defaultUnit: string | null
  referenceRange: string | null
  category: 'lab' | 'imaging'
}

// SP5 messages shown after the order is placed (Ruling 3: local = registered PIN in the service area).
const LOCAL_MESSAGE = 'Home collection available for this patient'
const NOT_LOCAL_MESSAGE = 'Patient is outside the home-collection area: walk-in only'
const FIELD = 'w-full rounded-md border border-border px-3 py-2 text-sm'

// Reusable from any patient-chart context -- the caller (LabResultsSection's
// "Order Test" button) owns the trigger button and open/close state and
// passes this patient's id plus the test catalog (fetched server-side via
// listLabTests(), the same "prop-drilled reference data" shape as
// TransferAdmissionModal's `availableRooms`) as props.
export function OrderLabTestModal({ patientId, labTests, onClose }: { patientId: string; labTests: LabTestOption[]; onClose: () => void }) {
  const router = useRouter()
  const id = useId()
  const [selected, setSelected] = useState<number[]>([])
  const [askFollowUp, setAskFollowUp] = useState(false)
  const [intervalValue, setIntervalValue] = useState('2')
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('weeks')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<{ patientIsLocal: boolean; includesLabTest: boolean } | null>(null)

  function toggle(testId: number) {
    setSelected((s) => (s.includes(testId) ? s.filter((x) => x !== testId) : [...s, testId]))
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
    const labTestIds = labTests.filter((t) => selected.includes(t.id)).map((t) => t.id)
    setSubmitting(true)
    const res = await sendJson<{ patientIsLocal?: boolean } | null>(`/api/patients/${patientId}/lab-orders`, 'POST', { labTestIds, followUp })
    setSubmitting(false)
    if (res.ok) {
      // SP5: imaging is never home-collected, so an imaging-only order gets no home-collection line.
      const includesLabTest = labTests.some((t) => labTestIds.includes(t.id) && t.category === 'lab')
      setPlaced({ patientIsLocal: res.data?.patientIsLocal === true, includesLabTest })
      router.refresh()
      return
    }
    setError(res.error)
  }

  const count = selected.length
  const canSubmit = count > 0 && !submitting
  const labOptions = labTests.filter((t) => t.category === 'lab')
  const imagingOptions = labTests.filter((t) => t.category === 'imaging')

  const group = (legend: string, options: LabTestOption[]) =>
    options.length > 0 && (
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{legend}</legend>
        {options.map((t) => (
          <label key={t.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
            <span>{t.name} ({t.code})</span>
          </label>
        ))}
      </fieldset>
    )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Order Lab Tests</DialogTitle>
        </DialogHeader>
        {placed ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Tests ordered.</p>
            {placed.includesLabTest && <p role="status" className="text-sm">{placed.patientIsLocal ? LOCAL_MESSAGE : NOT_LOCAL_MESSAGE}</p>}
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {group('Labs', labOptions)}
              {group('Imaging', imagingOptions)}
              {labTests.length === 0 && <p className="text-sm text-warning">No lab tests are available in the catalog.</p>}

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
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={submit} disabled={!canSubmit}>{count === 0 ? 'Order tests' : `Order ${count} test${count === 1 ? '' : 's'}`}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
