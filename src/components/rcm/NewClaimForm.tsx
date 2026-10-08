'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import type { NewClaimContext } from '@/lib/queries/claims'
import { Field, FormError, buttonClass, inputClass } from './ui'

const rupees = (paise: number) => (paise / 100).toFixed(2)

export function NewClaimForm({ ctx }: { ctx: NewClaimContext }) {
  const router = useRouter()
  const [claimType, setClaimType] = useState<'ipd' | 'daycare' | 'opd'>(ctx.claimType)
  const [preauthId, setPreauthId] = useState<string>(ctx.preauths[0] ? String(ctx.preauths[0].id) : '')
  const [picked, setPicked] = useState<Record<number, string>>(Object.fromEntries(ctx.invoices.map((i) => [i.invoiceId, rupees(i.availablePaise)])))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const invoices: { invoiceId: number; claimedPaise: number }[] = []
    for (const inv of ctx.invoices) {
      const raw = picked[inv.invoiceId]
      if (raw === undefined) continue
      const paise = parseRupeesToPaise(raw)
      if (paise === null || paise < 1 || paise > inv.availablePaise) { setError(`Enter an amount up to ${formatPaise(inv.availablePaise)} for ${inv.number}`); return }
      invoices.push({ invoiceId: inv.invoiceId, claimedPaise: paise })
    }
    if (invoices.length === 0) { setError('Choose at least one invoice'); return }
    setBusy(true)
    const r = await sendJson<{ claimId: number }>('/api/rcm/claims', 'POST', {
      policyId: ctx.policyId, claimType,
      ...(claimType === 'opd' ? { encounterId: ctx.encounterId ?? undefined } : { admissionId: ctx.admissionId ?? undefined }),
      ...(preauthId ? { preauthId: Number(preauthId) } : {}),
      invoices,
    })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    router.push(`/rcm/claims/${r.data.claimId}`)
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Claim type">
          <select className={inputClass} value={claimType} onChange={(e) => setClaimType(e.target.value as typeof claimType)}>
            {ctx.admissionId !== null ? (<><option value="ipd">Inpatient</option><option value="daycare">Daycare</option></>) : <option value="opd">Outpatient</option>}
          </select>
        </Field>
        <Field label="Pre-authorisation">
          <select className={inputClass} value={preauthId} onChange={(e) => setPreauthId(e.target.value)}>
            <option value="">None</option>
            {ctx.preauths.map((p) => <option key={p.id} value={p.id}>{p.preauthNumber} · {p.approvedPaise === null ? '—' : formatPaise(p.approvedPaise)}{p.validUntil ? ` · valid to ${formatIsoDate(p.validUntil)}` : ''}</option>)}
          </select>
        </Field>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground"><tr><th /><th>Invoice</th><th className="text-right">Total</th><th className="text-right">Claimed elsewhere</th><th className="text-right">Claim (₹)</th></tr></thead>
        <tbody>
          {ctx.invoices.map((inv) => (
            <tr key={inv.invoiceId} className="border-t border-border">
              <td><input type="checkbox" aria-label={`Claim ${inv.number}`} checked={picked[inv.invoiceId] !== undefined}
                onChange={(e) => setPicked((p) => { const n = { ...p }; if (e.target.checked) n[inv.invoiceId] = rupees(inv.availablePaise); else delete n[inv.invoiceId]; return n })} /></td>
              <td>{inv.number} <span className="text-xs text-muted-foreground">{inv.date ? formatIsoDate(inv.date) : ''}</span></td>
              <td className="text-right tabular-nums">{formatPaise(inv.totalPaise)}</td>
              <td className="text-right tabular-nums">{formatPaise(inv.claimedElsewherePaise)}</td>
              <td className="text-right"><input className={`${inputClass} w-32 text-right`} aria-label={`Amount for ${inv.number}`} disabled={picked[inv.invoiceId] === undefined}
                value={picked[inv.invoiceId] ?? ''} onChange={(e) => setPicked((p) => ({ ...p, [inv.invoiceId]: e.target.value }))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <FormError error={error} />
      <button type="submit" disabled={busy} className={buttonClass}>{busy ? 'Creating…' : 'Create draft claim'}</button>
    </form>
  )
}
