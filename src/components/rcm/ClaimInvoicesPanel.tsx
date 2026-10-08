'use client'
import { useState } from 'react'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { useRcmAction } from './useRcmAction'
import { FormError, Panel, buttonClass, inputClass } from './ui'

export function ClaimInvoicesPanel({ claimId, invoices, editable }: { claimId: number; invoices: ClaimWorkspace['invoices']; editable: boolean }) {
  const [amounts, setAmounts] = useState<Record<number, string>>(Object.fromEntries(invoices.map((i) => [i.invoiceId, (i.claimedPaise / 100).toFixed(2)])))
  const action = useRcmAction()

  async function save() {
    const list = invoices.map((i) => ({ invoiceId: i.invoiceId, claimedPaise: parseRupeesToPaise(amounts[i.invoiceId] ?? '') }))
    if (list.some((l) => l.claimedPaise === null || l.claimedPaise < 1)) { action.setError('Enter a claimed amount for every invoice'); return }
    await action.send(`/api/rcm/claims/${claimId}/invoices`, 'PUT', { invoices: list })
  }

  return (
    <Panel title="Invoices" actions={editable ? <button type="button" className={buttonClass} disabled={action.busy} onClick={save}>Save amounts</button> : undefined}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground"><tr><th>Invoice</th><th>Status</th><th className="text-right">Total</th><th className="text-right">Claimed</th></tr></thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.invoiceId} className="border-t border-border">
              <td>{i.number ?? `Draft #${i.invoiceId}`} <span className="text-xs text-muted-foreground">{i.date ? formatIsoDate(i.date) : ''}</span></td>
              <td>{i.status}</td>
              <td className="text-right tabular-nums">{i.totalPaise === null ? '—' : formatPaise(i.totalPaise)}</td>
              <td className="text-right">{editable
                ? <input className={`${inputClass} w-32 text-right`} aria-label={`Claimed for ${i.number ?? i.invoiceId}`} value={amounts[i.invoiceId] ?? ''} onChange={(e) => setAmounts((a) => ({ ...a, [i.invoiceId]: e.target.value }))} />
                : <span className="tabular-nums">{formatPaise(i.claimedPaise)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <FormError error={action.error} />
    </Panel>
  )
}
