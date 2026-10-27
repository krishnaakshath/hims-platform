'use client'
// WS2 T11: the workspace Procedures tab: pick a procedure service (priced for this visit), order
// it with a quantity and a note, and see the visit's procedures with whether they are billed.
// Ordering bills the procedure at once; a blocked or unpriced charge keeps the procedure and says
// why. An uncoded procedure can be cancelled here; a coded one belongs to the coder.
import { useCallback, useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/money'
import type { AutoChargeOutcome } from '@/lib/queries/auto-charge'
import type { EncounterProcedureRow, ProcedureOption } from '@/lib/queries/procedure-orders'

const NOTES_MAX = 300 // orderProcedureSchema
const SEARCH_DELAY_MS = 200
const FIELD = 'w-full rounded-md border border-border px-3 py-2 text-sm'

const BILLING_LABEL: Record<EncounterProcedureRow['billing'], string> = { billed: 'On the bill', void: 'Charge voided', not_billed: 'Not billed' }
const NOT_BILLED_REASON: Record<Extract<AutoChargeOutcome, { ok: false }>['reason'], string> = {
  no_context: 'no visit or stay to bill',
  context_cancelled: 'the visit is cancelled',
  no_service: 'no billing service',
  price_unresolved: 'no rate',
  blocked: 'a billing rule blocked it',
}
const RULE_REASON: Partial<Record<string, string>> = {
  deposit_below_threshold: 'the admission deposit is below the threshold',
  consultation_required: 'no consultation in the window before it',
  department_mismatch: 'the procedure belongs to another department',
  quantity_limit: 'the quantity is over the limit for this service',
}
const CANCEL_MESSAGE: Record<'voided' | 'none' | 'credit_note_needed', string> = {
  voided: 'Cancelled. The charge was removed from the bill.',
  none: 'Cancelled.',
  credit_note_needed: 'Cancelled. The charge is on a finalised invoice: billing must issue a credit note.',
}

function outcomeText(c: AutoChargeOutcome): string {
  if (c.ok) return `${c.itemName} ${formatPaise(c.taxablePaise)} on the bill (${c.billTo === 'payer' ? 'insurer' : 'self-pay'})`
  const rule = c.reason === 'blocked' ? c.rules?.map((r) => RULE_REASON[r]).find((t) => t) : undefined
  return `Procedure recorded, not billed: ${rule ?? NOT_BILLED_REASON[c.reason]}`
}

export function ProceduresPanel({ encounterId, canWrite }: { encounterId: number; canWrite: boolean }) {
  const router = useRouter()
  const ids = useId()
  const [procedures, setProcedures] = useState<EncounterProcedureRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  const [q, setQ] = useState('')
  const [found, setFound] = useState<ProcedureOption[]>([])
  const options = q.trim() === '' ? [] : found // a cleared search lists nothing
  const [serviceId, setServiceId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; warn: boolean } | null>(null)

  useEffect(() => {
    let live = true
    fetchJson<{ procedures: EncounterProcedureRow[] }>(`/api/encounters/${encounterId}/procedures`).then((r) => {
      if (!live) return
      if (!r.ok) { setLoadError(r.error); return }
      setLoadError(null)
      setProcedures(r.data.procedures)
    })
    return () => { live = false }
  }, [encounterId, reloadKey])

  useEffect(() => {
    if (!canWrite) return
    const term = q.trim()
    if (term === '') return
    let live = true
    const t = setTimeout(() => {
      fetchJson<{ options: ProcedureOption[] }>(`/api/encounters/${encounterId}/procedure-options?q=${encodeURIComponent(term)}`).then((r) => {
        if (!live) return
        if (!r.ok) { setError(r.error); return }
        setFound(r.data.options)
      })
    }, SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(t) }
  }, [encounterId, q, canWrite])

  async function order() {
    if (!serviceId) { setError('Choose a procedure.'); return }
    setBusy(true)
    setError(null)
    setMessage(null)
    const body: { serviceId: number; quantity: number; notes?: string } = { serviceId: Number(serviceId), quantity: Number(quantity) }
    if (notes.trim()) body.notes = notes.trim()
    const r = await sendJson<{ procedureId: number; charge: AutoChargeOutcome }>(`/api/encounters/${encounterId}/procedures`, 'POST', body)
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setMessage({ text: outcomeText(r.data.charge), warn: !r.data.charge.ok })
    setServiceId('')
    setQuantity('1')
    setNotes('')
    reload()
    router.refresh()
  }

  async function cancel(p: EncounterProcedureRow) {
    setError(null)
    setMessage(null)
    const r = await sendJson<{ ok: true; billing: keyof typeof CANCEL_MESSAGE }>(`/api/encounters/${encounterId}/procedures/${p.id}`, 'DELETE')
    if (!r.ok) { setError(r.error); return }
    setMessage({ text: CANCEL_MESSAGE[r.data.billing], warn: r.data.billing === 'credit_note_needed' })
    reload()
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {canWrite && (
        <section className="space-y-2 rounded-lg border border-border p-3">
          <h3 className="text-sm font-semibold">Order a procedure</h3>
          <div>
            <label htmlFor={`${ids}-q`} className="mb-1 block text-xs font-medium">Search procedures</label>
            <input id={`${ids}-q`} className={FIELD} value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} placeholder="Name or code" />
          </div>
          <div>
            <label htmlFor={`${ids}-svc`} className="mb-1 block text-xs font-medium">Procedure</label>
            <select id={`${ids}-svc`} className={FIELD} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">{options.length === 0 ? 'Search to list procedures' : 'Choose a procedure'}</option>
              {options.map((o) => (
                <option key={o.serviceId} value={String(o.serviceId)}>
                  {`${o.name} (${o.code}) · ${o.departmentName} · ${o.pricePaise === null ? 'no rate' : formatPaise(o.pricePaise)}`}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <div className="w-24">
              <label htmlFor={`${ids}-qty`} className="mb-1 block text-xs font-medium">Quantity</label>
              <input id={`${ids}-qty`} type="number" min={1} max={10} className={FIELD} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="flex-1">
              <label htmlFor={`${ids}-notes`} className="mb-1 block text-xs font-medium">Notes</label>
              <input id={`${ids}-notes`} className={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={NOTES_MAX} />
            </div>
          </div>
          <button type="button" onClick={order} disabled={busy} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            Order procedure
          </button>
        </section>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className={`text-sm ${message.warn ? 'text-warning' : 'text-success'}`}>{message.text}</p>}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Procedures on this visit</h3>
        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
        {procedures === null && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {procedures?.length === 0 && <p className="text-sm text-muted-foreground">No procedures on this visit.</p>}
        {procedures && procedures.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {procedures.map((p) => (
              <li key={p.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${p.status === 'cancelled' ? 'text-muted-foreground' : ''}`}>
                <span className="font-medium">{p.name}</span>
                {p.quantity !== null && p.quantity > 1 && <span className="text-xs">× {p.quantity}</span>}
                {p.codingStatus === 'coded' && <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">Coded</span>}
                <span className="ml-auto text-xs">{p.status === 'cancelled' ? 'Cancelled' : 'Ordered'}</span>
                {p.taxablePaise !== null && <span className="tabular-nums">{formatPaise(p.taxablePaise)}</span>}
                <span className={`text-xs ${p.billing === 'not_billed' ? 'text-warning' : 'text-muted-foreground'}`}>{BILLING_LABEL[p.billing]}</span>
                {canWrite && p.status === 'active' && p.codingStatus !== 'coded' && (
                  <button type="button" aria-label={`Cancel ${p.name}`} onClick={() => cancel(p)} className="text-xs text-destructive underline">
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
