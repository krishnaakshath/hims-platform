'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/components/tariff/api'
import { INDIAN_STATES, stateName } from '@/lib/india/reference'
import { payerBillingFlagsSchema } from '@/lib/billing/validation'

export interface PayerFlagsView { id: number; name: string; requiresPreauth: boolean; gstin: string | null; stateCode: string | null }

const CELL = 'rounded-md border border-border bg-background px-2 py-1 text-sm'

function PayerRow({ payer, editable }: { payer: PayerFlagsView; editable: boolean }) {
  const [v, setV] = useState({ requiresPreauth: payer.requiresPreauth, gstin: payer.gstin ?? '', stateCode: payer.stateCode ?? '' })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setMsg(null)
    const parsed = payerBillingFlagsSchema.safeParse({ requiresPreauth: v.requiresPreauth, gstin: v.gstin.trim() ? v.gstin : null, stateCode: v.stateCode || null })
    if (!parsed.success) { setMsg({ ok: false, text: parsed.error.issues[0]?.message ?? 'Check the details' }); return }
    setBusy(true)
    const res = await sendJson(`/api/billing/payers/${payer.id}`, 'PUT', parsed.data)
    setBusy(false)
    setMsg(res.ok ? { ok: true, text: 'Saved' } : { ok: false, text: res.error })
  }

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2 font-medium">{payer.name}</td>
      <td className="px-3 py-2">
        {editable
          ? <input type="checkbox" aria-label={`Needs pre-authorisation: ${payer.name}`} checked={v.requiresPreauth} onChange={(e) => setV({ ...v, requiresPreauth: e.target.checked })} />
          : (payer.requiresPreauth ? 'Yes' : 'No')}
      </td>
      <td className="px-3 py-2">
        {editable ? <input aria-label={`GSTIN: ${payer.name}`} value={v.gstin} maxLength={15} onChange={(e) => setV({ ...v, gstin: e.target.value })} className={`${CELL} w-44 uppercase`} /> : (payer.gstin ?? '—')}
      </td>
      <td className="px-3 py-2">
        {editable ? (
          <select aria-label={`State: ${payer.name}`} value={v.stateCode} onChange={(e) => setV({ ...v, stateCode: e.target.value })} className={CELL}>
            <option value="">—</option>
            {INDIAN_STATES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        ) : (payer.stateCode ? stateName(payer.stateCode) : '—')}
      </td>
      {editable && (
        <td className="px-3 py-2 text-right">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save()}>Save</Button>
          {msg && <p className={`mt-1 text-xs ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{msg.text}</p>}
        </td>
      )}
    </tr>
  )
}

/** SP4: payer billing flags (pre-authorisation, GSTIN, state). Editable for admin only. */
export function PayerFlagsTable({ payers, editable }: { payers: PayerFlagsView[]; editable: boolean }) {
  if (payers.length === 0) return <p className="text-sm text-muted-foreground">No payers on file.</p>
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Payer</th>
            <th className="px-3 py-2">Pre-authorisation</th>
            <th className="px-3 py-2">GSTIN</th>
            <th className="px-3 py-2">State</th>
            {editable && <th className="px-3 py-2"><span className="sr-only">Save</span></th>}
          </tr>
        </thead>
        <tbody>{payers.map((p) => <PayerRow key={p.id} payer={p} editable={editable} />)}</tbody>
      </table>
    </div>
  )
}
