'use client'
import { useState } from 'react'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import type { RcmReasonCodeRow } from '@/db/schema'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

export function WriteOffPanel({ claimId, writeOffs, ceilingPaise, canRequest, canDecide, viewerUserId, reasonCodes }: {
  claimId: number; writeOffs: ClaimWorkspace['writeOffs']; ceilingPaise: number; canRequest: boolean; canDecide: boolean; viewerUserId: number | null; reasonCodes: RcmReasonCodeRow[]
}) {
  const codes = reasonCodes.filter((c) => c.category === 'write_off')
  const [f, setF] = useState({ amount: '', reasonCode: codes[0]?.code ?? '', note: '' })
  const action = useRcmAction()
  const amountPaise = parseRupeesToPaise(f.amount)
  return (
    <Panel title="Write-offs">
      <ul className="space-y-1 text-sm">
        {writeOffs.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-1">
            <span>{formatPaise(w.amountPaise)} · {w.reasonCode} · {w.status} · requested by {w.requestedByName}{w.decidedByName ? ` · decided by ${w.decidedByName}` : ''}</span>
            {canDecide && w.status === 'requested' && (viewerUserId === null || viewerUserId !== w.requestedByUserId) && (
              <span className="flex gap-1">
                <button type="button" className={buttonClass} disabled={action.busy} onClick={() => action.send(`/api/rcm/write-offs/${w.id}/decision`, 'POST', { decision: 'approve' })}>Approve</button>
                <button type="button" className={secondaryButtonClass} disabled={action.busy} onClick={() => action.send(`/api/rcm/write-offs/${w.id}/decision`, 'POST', { decision: 'reject' })}>Reject</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canRequest && ceilingPaise > 0 && (
        <form className="mt-3 grid gap-2 sm:grid-cols-3" onSubmit={async (e) => { e.preventDefault(); if (amountPaise === null) return
          if (await action.send(`/api/rcm/claims/${claimId}/write-offs`, 'POST', { amountPaise, reasonCode: f.reasonCode, note: f.note })) setF({ ...f, amount: '', note: '' }) }}>
          <Field label={`Amount (₹, at most ${formatPaise(ceilingPaise)})`}><input className={inputClass} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Reason"><select className={inputClass} value={f.reasonCode} onChange={(e) => setF({ ...f, reasonCode: e.target.value })}>{codes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></Field>
          <Field label="Note"><input className={inputClass} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <div className="sm:col-span-3"><button type="submit" className={buttonClass} disabled={action.busy || amountPaise === null}>Request write-off</button></div>
        </form>
      )}
      <FormError error={action.error} />
    </Panel>
  )
}
