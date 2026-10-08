'use client'
import { useState } from 'react'
import { parseRupeesToPaise } from '@/lib/format'
import { PREAUTH_ACTIONS, nextPreauthStatus, type PreauthAction, type PreauthStatus } from '@/lib/rcm/preauth-status'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass } from './ui'

const LABEL: Record<PreauthAction, string> = {
  request: 'Send request', record_query: 'Record insurer query', respond_query: 'Respond to query', approve: 'Record approval', reject: 'Record rejection',
  request_enhancement: 'Request enhancement', approve_enhancement: 'Record enhancement approval', reject_enhancement: 'Record enhancement rejection', cancel: 'Cancel',
}

type F = { name: string; label: string; type?: 'date' | 'textarea' | 'rupees'; options?: { value: string; label: string }[] }
const FIELDS: Record<PreauthAction, F[]> = {
  request: [],
  record_query: [{ name: 'question', label: 'Question', type: 'textarea' }, { name: 'raisedOn', label: 'Raised on', type: 'date' }, { name: 'dueOn', label: 'Reply due', type: 'date' }],
  respond_query: [{ name: 'body', label: 'Reply', type: 'textarea' }, { name: 'respondedOn', label: 'Responded on', type: 'date' }],
  approve: [{ name: 'approvedPaise', label: 'Approved (₹)', type: 'rupees' }, { name: 'approvalReference', label: 'Approval reference' }, { name: 'validUntil', label: 'Valid until', type: 'date' }, { name: 'decidedOn', label: 'Decided on', type: 'date' }],
  reject: [{ name: 'reasonCode', label: 'Reason' }, { name: 'note', label: 'Note', type: 'textarea' }, { name: 'decidedOn', label: 'Decided on', type: 'date' }],
  request_enhancement: [{ name: 'requestedPaise', label: 'New total requested (₹)', type: 'rupees' }, { name: 'note', label: 'Why (longer stay, added procedure)', type: 'textarea' }],
  approve_enhancement: [{ name: 'approvedPaise', label: 'New approved total (₹)', type: 'rupees' }, { name: 'approvalReference', label: 'New approval reference (optional)' }, { name: 'validUntil', label: 'Valid until', type: 'date' }, { name: 'decidedOn', label: 'Decided on', type: 'date' }],
  reject_enhancement: [{ name: 'reasonCode', label: 'Reason' }, { name: 'note', label: 'Note', type: 'textarea' }, { name: 'decidedOn', label: 'Decided on', type: 'date' }],
  cancel: [{ name: 'note', label: 'Why it is cancelled', type: 'textarea' }],
}

function ActionForm({ preauthId, action, openQueryId, reasons }: { preauthId: number; action: PreauthAction; openQueryId: number | null; reasons: { value: string; label: string }[] }) {
  const [v, setV] = useState<Record<string, string>>({})
  const run = useRcmAction()
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const body: Record<string, unknown> = { action }
    for (const f of FIELDS[action]) {
      const raw = (v[f.name] ?? (f.name === 'reasonCode' ? reasons[0]?.value ?? '' : '')).trim()
      const optional = ((action === 'reject' || action === 'reject_enhancement') && f.name === 'note') || (action === 'approve_enhancement' && f.name === 'approvalReference')
      if (raw === '' && optional) continue
      if (f.type === 'rupees') { const p = parseRupeesToPaise(raw); if (p === null) { run.setError(`Enter ${f.label.toLowerCase()}`); return } body[f.name] = p } else body[f.name] = raw
    }
    if (action === 'respond_query') body.queryId = openQueryId
    await run.send(`/api/rcm/preauths/${preauthId}/actions`, 'POST', body)
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS[action].map((f) => (
          <Field key={f.name} label={f.label}>
            {f.name === 'reasonCode' ? <select className={inputClass} value={v.reasonCode ?? reasons[0]?.value ?? ''} onChange={(e) => setV({ ...v, reasonCode: e.target.value })}>{reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
              : f.type === 'textarea' ? <textarea className={inputClass} rows={2} value={v[f.name] ?? ''} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
              : <input type={f.type === 'date' ? 'date' : 'text'} className={inputClass} value={v[f.name] ?? ''} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />}
          </Field>
        ))}
      </div>
      <button type="submit" className={buttonClass} disabled={run.busy}>{LABEL[action]}</button>
      <FormError error={run.error} />
    </form>
  )
}

/** Only the steps nextPreauthStatus allows from the current status. */
export function PreauthActions({ preauthId, status, enhancedBefore, openQueryId, rejectionReasons }: { preauthId: number; status: PreauthStatus; enhancedBefore: boolean; openQueryId: number | null; rejectionReasons: { value: string; label: string }[] }) {
  const allowed = PREAUTH_ACTIONS.filter((a) => nextPreauthStatus(status, a, { enhancedBefore }) !== null && (a !== 'respond_query' || openQueryId !== null))
  if (allowed.length === 0) return null
  return (
    <Panel title="Next steps">
      <div className="space-y-2">
        {allowed.map((a) => (
          <details key={a}><summary className="cursor-pointer text-sm font-medium">{LABEL[a]}</summary><ActionForm preauthId={preauthId} action={a} openQueryId={openQueryId} reasons={rejectionReasons} /></details>
        ))}
      </div>
    </Panel>
  )
}
