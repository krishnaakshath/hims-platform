'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ImagingAttachmentStrip, type AttachmentView } from '@/components/ImagingAttachmentStrip'
// WS4 T9
import { flagAnalyteValue, rangeText, selectRange, type AnalyteDef, type Interpretation } from '@/lib/labs/analytes'
import { FLAG_REASON_MAX, FLAG_REASON_MIN } from '@/lib/labs/validation'
import type { AnalyteResultRow } from '@/lib/queries/lab-result-values'
// end WS4 T9

type Flag = 'normal' | 'abnormal' | 'critical'

// ── WS4 T9 (spec 3.3 item 19): one row per analyte, live automatic flag ─────

const FLAGS: Flag[] = ['normal', 'abnormal', 'critical']
const SEVERITY: Record<Flag, number> = { normal: 0, abnormal: 1, critical: 2 }
const FLAG_TEXT: Record<Flag, string> = { normal: 'Normal', abnormal: 'Abnormal', critical: 'Critical' }
const INTERPRETATION_TEXT: Record<Interpretation, string> = {
  N: 'Normal', L: 'Low', H: 'High', LL: 'Critical low', HH: 'Critical high', A: 'Abnormal', AA: 'Critical',
}
const CHIP_CLASS: Record<Flag, string> = { normal: 'text-muted-foreground', abnormal: 'text-warning', critical: 'text-destructive font-semibold' }

interface AnalyteDraft { value: string; flag: Flag | ''; reason: string }

function AnalyteResultForm({ orderId, analytes, patientSex, ageDays, initial, onClose, title }: {
  orderId: number
  analytes: AnalyteDef[]
  patientSex: 'male' | 'female' | null
  ageDays: number
  initial: { notes?: string | null; analytes?: AnalyteResultRow[] } | null
  onClose: () => void
  title: string
}) {
  const router = useRouter()
  const [drafts, setDrafts] = useState<Record<number, AnalyteDraft>>(() => {
    const prior = new Map((initial?.analytes ?? []).map((a) => [a.analyteId, a]))
    return Object.fromEntries(analytes.map((d) => {
      const p = prior.get(d.id)
      const manual = p?.flagSource === 'manual'
      return [d.id, { value: p?.value ?? '', flag: manual ? p.flag : '', reason: manual ? (p.flagReason ?? '') : '' }]
    }))
  })
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = analytes.map((def) => {
    const draft = drafts[def.id]
    const range = selectRange(def.ranges, patientSex, ageDays)
    const computed = flagAnalyteValue(def, draft.value, range)
    // A chosen flag never sits below the automatic one: a higher value can raise the computed flag past it.
    const chosen = draft.flag !== '' && (computed === null || SEVERITY[draft.flag] >= SEVERITY[computed.flag]) ? draft.flag : null
    const effective: Flag | null = chosen ?? computed?.flag ?? null
    const manual = effective !== null && (computed === null || SEVERITY[effective] > SEVERITY[computed.flag])
    const options = computed === null ? FLAGS : FLAGS.filter((f) => SEVERITY[f] >= SEVERITY[computed.flag])
    const reasonOk = draft.reason.trim().length >= FLAG_REASON_MIN
    const complete = draft.value.trim() !== '' && effective !== null && (!manual || reasonOk)
    return { def, draft, range, computed, effective, manual, options, complete }
  })

  const update = (id: number, patch: Partial<AnalyteDraft>) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/lab-orders/${orderId}/result`, 'POST', {
      analytes: rows.map((r) => ({
        analyteId: r.def.id,
        value: r.draft.value.trim(),
        ...(r.manual && r.effective ? { flagOverride: { flag: r.effective, reason: r.draft.reason.trim() } } : {}),
      })),
      ...(notes.trim() ? { notes } : {}),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  const canSubmit = rows.every((r) => r.complete) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium">Analyte</th>
                <th scope="col" className="py-1 pr-2 font-medium">Value</th>
                <th scope="col" className="py-1 pr-2 font-medium">Reference range</th>
                <th scope="col" className="py-1 pr-2 font-medium">Flag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ def, draft, range, computed, effective, manual, options }) => (
                <tr key={def.id} className="border-t border-border align-top">
                  <th scope="row" className="py-2 pr-2 text-left font-medium text-foreground">{def.name}</th>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1">
                      <input value={draft.value} onChange={(e) => update(def.id, { value: e.target.value })} maxLength={60}
                        aria-label={`Value for ${def.name}`} inputMode={def.valueType === 'numeric' ? 'decimal' : undefined}
                        list={def.valueType === 'option' ? `analyte-options-${def.id}` : undefined}
                        className="w-28 rounded-md border border-border px-2 py-1 text-sm" />
                      {def.valueType === 'option' && def.options && (
                        <datalist id={`analyte-options-${def.id}`}>{def.options.map((o) => <option key={o} value={o} />)}</datalist>
                      )}
                      {def.unit && <span className="text-xs text-muted-foreground">{def.unit}</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-xs text-muted-foreground">{rangeText(range, def.unit) ?? '—'}</td>
                  <td className="py-2 pr-2">
                    <div className="flex flex-col gap-1">
                      {draft.value.trim() !== '' && (
                        computed
                          ? <span className={`text-xs ${CHIP_CLASS[computed.flag]}`}>{INTERPRETATION_TEXT[computed.interpretation]}</span>
                          : <span className="text-xs text-muted-foreground">No automatic flag</span>
                      )}
                      <select value={effective ?? ''} onChange={(e) => update(def.id, { flag: e.target.value as Flag | '' })}
                        aria-label={`Flag for ${def.name}`} className="rounded-md border border-border px-2 py-1 text-xs">
                        {computed === null && <option value="">Choose flag</option>}
                        {options.map((f) => <option key={f} value={f}>{FLAG_TEXT[f]}</option>)}
                      </select>
                      {manual && (
                        <input value={draft.reason} onChange={(e) => update(def.id, { reason: e.target.value })} maxLength={FLAG_REASON_MAX}
                          placeholder="Reason (required)" aria-label={`Reason for the ${def.name} flag`}
                          className="rounded-md border border-border px-2 py-1 text-xs" />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" rows={2} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save result</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
// end WS4 T9

export function EnterLabResultModal({
  orderId,
  testName,
  defaultUnit,
  defaultReferenceRange,
  category,
  attachments,
  initial = null,
  onClose,
  analytes = [],
  patientSex = null,
  ageDays = 0,
}: {
  orderId: number
  testName: string
  defaultUnit: string | null
  defaultReferenceRange: string | null
  category: 'lab' | 'imaging'
  attachments: AttachmentView[]
  /** The current result when amending: every field starts from it. */
  initial?: { value: string; unit: string | null; referenceRange?: string | null; notes?: string | null; flag: Flag; analytes?: AnalyteResultRow[] } | null
  onClose: () => void
  // WS4 T9: the test's active analytes (none: today's single-value form) and the patient's
  // sex and age in days on the collection date, which choose each analyte's range.
  analytes?: AnalyteDef[]
  patientSex?: 'male' | 'female' | null
  ageDays?: number
}) {
  if (category === 'lab' && analytes.length > 0) {
    return <AnalyteResultForm orderId={orderId} analytes={analytes} patientSex={patientSex} ageDays={ageDays} initial={initial} onClose={onClose}
      title={`${initial ? 'Amend result' : 'Enter Result'} — ${testName}`} />
  }
  return <SingleValueResultForm {...{ orderId, testName, defaultUnit, defaultReferenceRange, category, attachments, initial, onClose }} />
}

function SingleValueResultForm({ orderId, testName, defaultUnit, defaultReferenceRange, category, attachments, initial, onClose }: {
  orderId: number
  testName: string
  defaultUnit: string | null
  defaultReferenceRange: string | null
  category: 'lab' | 'imaging'
  attachments: AttachmentView[]
  initial: { value: string; unit: string | null; referenceRange?: string | null; notes?: string | null; flag: Flag } | null
  onClose: () => void
}) {
  const router = useRouter()
  const [value, setValue] = useState(initial?.value ?? '')
  const [unit, setUnit] = useState((initial ? initial.unit : defaultUnit) ?? '')
  const [referenceRange, setReferenceRange] = useState((initial ? initial.referenceRange : defaultReferenceRange) ?? '')
  const [flag, setFlag] = useState<Flag>(initial?.flag ?? 'normal')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/lab-orders/${orderId}/result`, 'POST', {
      value,
      ...(unit ? { unit } : {}),
      ...(referenceRange ? { referenceRange } : {}),
      flag,
      ...(notes ? { notes } : {}),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  const canSubmit = Boolean(value.trim()) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Amend result' : 'Enter Result'} — {testName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {category === 'imaging' && <ImagingAttachmentStrip attachments={attachments} />}
          {category === 'imaging' ? (
            <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="Impression" aria-label="Impression" rows={3} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Result value" aria-label="Result value" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          )}
          {category === 'lab' && (
            <div className="grid grid-cols-2 gap-2">
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" aria-label="Unit" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
              <input value={referenceRange} onChange={(e) => setReferenceRange(e.target.value)} placeholder="Reference range" aria-label="Reference range" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
          )}
          <select value={flag} onChange={(e) => setFlag(e.target.value as Flag)} aria-label="Flag" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="normal">Normal</option>
            <option value="abnormal">Abnormal</option>
            <option value="critical">Critical</option>
          </select>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" rows={2} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save result</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
