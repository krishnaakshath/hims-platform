'use client'
import { useState } from 'react'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { settlementProblems, settlementWarnings } from '@/lib/rcm/amounts'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

function Reconcile({ id }: { id: number }) {
  const [date, setDate] = useState('')
  const action = useRcmAction()
  return (
    <span className="inline-flex items-center gap-1">
      <input type="date" aria-label="Bank credit date" className={`${inputClass} w-36`} value={date} onChange={(e) => setDate(e.target.value)} />
      <button type="button" className={secondaryButtonClass} disabled={!date || action.busy} onClick={() => action.send(`/api/rcm/settlements/${id}/reconcile`, 'POST', { bankCreditDate: date })}>Reconcile</button>
      <FormError error={action.error} />
    </span>
  )
}

export function SettlementPanel({ claimId, canRecord, settlements, approvedPaise, settledPaise }: { claimId: number; canRecord: boolean; settlements: ClaimWorkspace['settlements']; approvedPaise: number | null; settledPaise: number }) {
  const [f, setF] = useState({ utr: '', paymentDate: '', received: '', tds: '0', bank: '0' })
  const action = useRcmAction()
  const amounts = { approvedPaise: approvedPaise ?? 0, alreadySettledPaise: settledPaise, receivedPaise: parseRupeesToPaise(f.received) ?? 0, tdsPaise: parseRupeesToPaise(f.tds) ?? -1, bankChargesPaise: parseRupeesToPaise(f.bank) ?? -1 }
  const problem = f.received === '' ? null : settlementProblems(amounts)
  const warnings = f.received === '' ? [] : settlementWarnings(amounts)
  return (
    <Panel title="Settlements">
      <ul className="space-y-1 text-sm">
        {settlements.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-1">
            <span>UTR {s.utr} · {formatIsoDate(s.paymentDate)} · {formatPaise(s.settledPaise)} (received {formatPaise(s.receivedPaise)}, TDS {formatPaise(s.tdsPaise)}, bank {formatPaise(s.bankChargesPaise)})</span>
            {s.reconciledAt ? <span className="text-xs text-muted-foreground">Reconciled{s.bankCreditDate ? ` ${formatIsoDate(s.bankCreditDate)}` : ''}</span> : <Reconcile id={s.id} />}
          </li>
        ))}
      </ul>
      {canRecord && (
        <form className="mt-3 grid gap-2 sm:grid-cols-5" onSubmit={async (e) => { e.preventDefault(); if (problem) return
          if (await action.send(`/api/rcm/claims/${claimId}/settlements`, 'POST', { utr: f.utr, paymentDate: f.paymentDate, receivedPaise: amounts.receivedPaise, tdsPaise: amounts.tdsPaise, bankChargesPaise: amounts.bankChargesPaise }))
            setF({ utr: '', paymentDate: '', received: '', tds: '0', bank: '0' }) }}>
          <Field label="UTR"><input className={inputClass} value={f.utr} onChange={(e) => setF({ ...f, utr: e.target.value })} /></Field>
          <Field label="Payment date"><input type="date" className={inputClass} value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} /></Field>
          <Field label="Received (₹)"><input className={inputClass} value={f.received} onChange={(e) => setF({ ...f, received: e.target.value })} /></Field>
          <Field label="TDS (₹)"><input className={inputClass} value={f.tds} onChange={(e) => setF({ ...f, tds: e.target.value })} /></Field>
          <Field label="Bank charges (₹)"><input className={inputClass} value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} /></Field>
          <div className="sm:col-span-5">
            {problem && <p className="text-xs text-amber-700">{problem}</p>}
            {warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
            <button type="submit" className={buttonClass} disabled={action.busy || problem !== null || !f.utr || !f.paymentDate}>Record settlement</button>
          </div>
        </form>
      )}
      <FormError error={action.error} />
    </Panel>
  )
}
