'use client'
import { useState } from 'react'
import { CHANNEL_LABEL, SUBMISSION_CHANNELS, type SubmissionChannel } from '@/lib/rcm/constants'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass } from './ui'

/** Submits the next version: `submit` for a draft, `respond_query` for an open query, or an appeal. */
export function SubmitClaimDialog({ claimId, mode, ready, queryId, nhcxLabel }: {
  claimId: number; mode: 'submit' | 'respond_query' | 'appeal' | null; ready: boolean; queryId: number | null; nhcxLabel: string
}) {
  const [channel, setChannel] = useState<SubmissionChannel>('portal')
  const [tracking, setTracking] = useState('')
  const [text, setText] = useState('')
  const [appealKind, setAppealKind] = useState<'appeal' | 'resubmission'>('appeal')
  const [respondedOn, setRespondedOn] = useState('')
  const action = useRcmAction()
  if (mode === null) return null
  const title = mode === 'submit' ? 'Submit to the insurer' : mode === 'respond_query' ? 'Answer the insurer query' : 'Appeal or resubmit'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const common = { channel, ...(tracking.trim() ? { trackingReference: tracking.trim() } : {}) }
    const body = mode === 'submit' ? { action: 'submit', ...common, ...(text.trim() ? { coverNote: text.trim() } : {}) }
      : mode === 'respond_query' ? { action: 'respond_query', queryId, body: text.trim(), respondedOn, ...common }
      : { action: 'appeal', appealKind, grounds: text.trim(), ...common }
    if (await action.send(`/api/rcm/claims/${claimId}/submissions`, 'POST', body)) { setText(''); setTracking('') }
  }

  return (
    <Panel title={title}>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2">
        <Field label="Channel">
          <select className={inputClass} value={channel} onChange={(e) => setChannel(e.target.value as SubmissionChannel)}>
            {SUBMISSION_CHANNELS.map((c) => <option key={c} value={c} disabled={c === 'nhcx'}>{c === 'nhcx' ? nhcxLabel : CHANNEL_LABEL[c]}</option>)}
          </select>
        </Field>
        <Field label="Tracking reference (portal ID, AWB, email subject)"><input className={inputClass} value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>
        {mode === 'appeal' && <Field label="Kind"><select className={inputClass} value={appealKind} onChange={(e) => setAppealKind(e.target.value as typeof appealKind)}><option value="appeal">Appeal</option><option value="resubmission">Resubmission</option></select></Field>}
        {mode === 'respond_query' && <Field label="Responded on"><input type="date" className={inputClass} value={respondedOn} onChange={(e) => setRespondedOn(e.target.value)} /></Field>}
        <div className="sm:col-span-2"><Field label={mode === 'submit' ? 'Cover note (optional)' : mode === 'respond_query' ? 'Reply' : 'Grounds'}><textarea className={inputClass} rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field></div>
        <div className="sm:col-span-2"><button type="submit" className={buttonClass} disabled={action.busy || !ready}>{action.busy ? 'Preparing copies…' : 'Submit version'}</button>
          {!ready && <span className="ml-2 text-xs text-muted-foreground">Clear the blocking items first.</span>}
          <a href={`/api/rcm/claims/${claimId}/preview`} target="_blank" rel="noreferrer" className="ml-3 text-xs text-primary hover:underline">Preview the copy</a></div>
      </form>
      <FormError error={action.error} items={action.items} />
    </Panel>
  )
}
