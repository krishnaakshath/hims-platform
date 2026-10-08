'use client'
import { useState } from 'react'
import { parseRupeesToPaise } from '@/lib/format'
import { approvalProblems } from '@/lib/rcm/amounts'
import type { ClaimAction } from '@/lib/rcm/claim-status'
import type { RcmReasonCodeRow } from '@/db/schema'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

type Row = { reasonCode: string; rupees: string; patientRecoverable: boolean }

function DecisionForm({ claimId, claimedPaise, codes }: { claimId: number; claimedPaise: number; codes: RcmReasonCodeRow[] }) {
  const [approved, setApproved] = useState('')
  const [decidedOn, setDecidedOn] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const action = useRcmAction()
  const approvedPaise = parseRupeesToPaise(approved)
  const disallowances = rows.map((r) => ({ reasonCode: r.reasonCode, amountPaise: parseRupeesToPaise(r.rupees) ?? 0, patientRecoverable: r.patientRecoverable }))
  const problem = approvedPaise === null ? 'Enter the approved amount' : approvalProblems({ claimedPaise, approvedPaise, disallowances })
  const deductionCodes = codes.filter((c) => c.category === 'disallowance')
  return (
    <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (problem || approvedPaise === null) return
      await action.send(`/api/rcm/claims/${claimId}/actions`, 'POST', { action: 'record_decision', approvedPaise, decidedOn, disallowances }) }}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Approved (₹)"><input className={inputClass} value={approved} onChange={(e) => setApproved(e.target.value)} /></Field>
        <Field label="Decided on"><input type="date" className={inputClass} value={decidedOn} onChange={(e) => setDecidedOn(e.target.value)} /></Field>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-4">
          <select aria-label="Deduction reason" className={inputClass} value={r.reasonCode} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, reasonCode: e.target.value, patientRecoverable: deductionCodes.find((c) => c.code === e.target.value)?.patientRecoverableDefault ?? x.patientRecoverable } : x)))}>
            {deductionCodes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
          <input aria-label="Deduction amount" className={inputClass} placeholder="₹" value={r.rupees} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, rupees: e.target.value } : x)))} />
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.patientRecoverable} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, patientRecoverable: e.target.checked } : x)))} />Patient pays</label>
          <button type="button" className={secondaryButtonClass} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className={secondaryButtonClass} onClick={() => setRows((rs) => [...rs, { reasonCode: deductionCodes[0]?.code ?? 'OTHER', rupees: '', patientRecoverable: deductionCodes[0]?.patientRecoverableDefault ?? false }])}>Add deduction</button>
      {problem && approved !== '' && <p className="text-xs text-amber-700">{problem}</p>}
      <button type="submit" className={buttonClass} disabled={action.busy || problem !== null || !decidedOn}>Record decision</button>
      <FormError error={action.error} />
    </form>
  )
}

function SimpleForm({ claimId, label, build, fields }: { claimId: number; label: string; build: (v: Record<string, string>) => unknown; fields: { name: string; label: string; type?: string; options?: { value: string; label: string }[] }[] }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, f.options?.[0]?.value ?? ''])))
  const action = useRcmAction()
  return (
    <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (await action.send(`/api/rcm/claims/${claimId}/actions`, 'POST', build(v))) setV(Object.fromEntries(fields.map((f) => [f.name, f.options?.[0]?.value ?? '']))) }}>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.name} label={f.label}>
            {f.options ? <select className={inputClass} value={v[f.name]} onChange={(e) => setV((x) => ({ ...x, [f.name]: e.target.value }))}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : f.type === 'textarea' ? <textarea className={inputClass} rows={2} value={v[f.name]} onChange={(e) => setV((x) => ({ ...x, [f.name]: e.target.value }))} />
              : <input type={f.type ?? 'text'} className={inputClass} value={v[f.name]} onChange={(e) => setV((x) => ({ ...x, [f.name]: e.target.value }))} />}
          </Field>
        ))}
      </div>
      <button type="submit" className={buttonClass} disabled={action.busy}>{label}</button>
      <FormError error={action.error} />
    </form>
  )
}

export function InsurerUpdateForms({ claimId, allowedActions, claimedPaise, reasonCodes }: { claimId: number; allowedActions: (ClaimAction | 'note')[]; claimedPaise: number; reasonCodes: RcmReasonCodeRow[] }) {
  const has = (a: ClaimAction | 'note') => allowedActions.includes(a)
  const rejection = reasonCodes.filter((c) => c.category === 'rejection').map((c) => ({ value: c.code, label: c.label }))
  return (
    <Panel title="Insurer portal updates">
      <div className="space-y-4">
        {has('record_query') && <details><summary className="cursor-pointer text-sm font-medium">Record a query</summary>
          <SimpleForm claimId={claimId} label="Record query" fields={[{ name: 'question', label: 'Question', type: 'textarea' }, { name: 'raisedOn', label: 'Raised on', type: 'date' }, { name: 'dueOn', label: 'Reply due', type: 'date' }]}
            build={(v) => ({ action: 'record_query', question: v.question, raisedOn: v.raisedOn, dueOn: v.dueOn })} /></details>}
        {(has('record_approval') || has('record_partial_approval')) && <details><summary className="cursor-pointer text-sm font-medium">Record the decision</summary>
          <DecisionForm claimId={claimId} claimedPaise={claimedPaise} codes={reasonCodes} /></details>}
        {has('record_rejection') && <details><summary className="cursor-pointer text-sm font-medium">Record a rejection</summary>
          <SimpleForm claimId={claimId} label="Record rejection" fields={[{ name: 'reasonCode', label: 'Reason', options: rejection }, { name: 'decidedOn', label: 'Decided on', type: 'date' },
            { name: 'patientRecoverable', label: 'Patient pays the rejected amount', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No, the hospital absorbs it' }] }, { name: 'note', label: 'Note', type: 'textarea' }]}
            build={(v) => ({ action: 'record_rejection', reasonCode: v.reasonCode, decidedOn: v.decidedOn, patientRecoverable: v.patientRecoverable === 'true', ...(v.note ? { note: v.note } : {}) })} /></details>}
        {has('withdraw') && <details><summary className="cursor-pointer text-sm font-medium">Withdraw the claim</summary>
          <SimpleForm claimId={claimId} label="Withdraw" fields={[{ name: 'reason', label: 'Reason', type: 'textarea' }]} build={(v) => ({ action: 'withdraw', reason: v.reason })} /></details>}
        {has('close') && <SimpleForm claimId={claimId} label="Close the claim" fields={[]} build={() => ({ action: 'close' })} />}
        {has('reopen') && <details><summary className="cursor-pointer text-sm font-medium">Reopen</summary>
          <SimpleForm claimId={claimId} label="Reopen" fields={[{ name: 'reason', label: 'Reason', type: 'textarea' }]} build={(v) => ({ action: 'reopen', reason: v.reason })} /></details>}
        {has('note') && <details><summary className="cursor-pointer text-sm font-medium">Add a portal note</summary>
          <SimpleForm claimId={claimId} label="Save note" fields={[{ name: 'note', label: 'What the portal shows', type: 'textarea' }, { name: 'portalCheckedOn', label: 'Checked on', type: 'date' }]}
            build={(v) => ({ action: 'note', note: v.note, portalCheckedOn: v.portalCheckedOn })} /></details>}
      </div>
    </Panel>
  )
}
