'use client'
import { useState } from 'react'
import { fetchJson } from '@/lib/client-fetch'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import { CHANNEL_LABEL, type SubmissionChannel } from '@/lib/rcm/constants'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { useRcmAction } from './useRcmAction'
import { FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

function Acknowledge({ dispatchId }: { dispatchId: number }) {
  const [ref, setRef] = useState('')
  const [on, setOn] = useState('')
  const action = useRcmAction()
  return (
    <div className="mt-1 flex flex-wrap items-end gap-2">
      <input className={`${inputClass} w-40`} placeholder="Insurer claim reference" aria-label="Insurer claim reference" value={ref} onChange={(e) => setRef(e.target.value)} />
      <input type="date" className={`${inputClass} w-40`} aria-label="Acknowledged on" value={on} onChange={(e) => setOn(e.target.value)} />
      <button type="button" className={secondaryButtonClass} disabled={action.busy || !ref || !on}
        onClick={() => action.send(`/api/rcm/dispatches/${dispatchId}/acknowledge`, 'POST', { insurerReference: ref, acknowledgedOn: on })}>Record acknowledgement</button>
      <FormError error={action.error} />
    </div>
  )
}

function Verify({ submissionId }: { submissionId: number }) {
  const [result, setResult] = useState<string | null>(null)
  return (
    <span>
      <button type="button" className={secondaryButtonClass} onClick={async () => {
        const r = await fetchJson<{ snapshotOk: boolean; rcmCopyOk: boolean; insurerCopyOk: boolean }>(`/api/rcm/submissions/${submissionId}/verify`)
        setResult(r.ok ? `Snapshot ${r.data.snapshotOk ? 'intact' : 'CHANGED'} · RCM copy ${r.data.rcmCopyOk ? 'intact' : 'CHANGED'} · insurer copy ${r.data.insurerCopyOk ? 'intact' : 'CHANGED'}` : r.error)
      }}>Verify</button>
      {result && <span className="ml-2 text-xs">{result}</span>}
    </span>
  )
}

export function ClaimVersionsPanel({ versions }: { versions: ClaimWorkspace['versions'] }) {
  return (
    <Panel title="Submitted versions">
      {versions.length === 0 ? <p className="text-sm text-muted-foreground">Not submitted yet.</p> : (
        <ul className="space-y-3 text-sm">
          {versions.map((v) => (
            <li key={v.id} className="border-t border-border pt-2">
              <p className="font-medium">Version {v.version} · {v.kind.replace('_', ' ')} · {formatDateTimeIn(v.createdAt)} · {v.createdByName}</p>
              <p className="font-mono text-xs text-muted-foreground">SHA-256 {v.snapshotSha256.slice(0, 12)}…</p>
              {v.dispatch && <p className="text-xs">{CHANNEL_LABEL[v.dispatch.channel as SubmissionChannel] ?? v.dispatch.channel} ({v.dispatch.transport}) on {formatIsoDate(v.dispatch.dispatchedOn)}{v.dispatch.trackingReference ? ` · tracking ${v.dispatch.trackingReference}` : ''}{v.dispatch.insurerReference ? ` · insurer ref ${v.dispatch.insurerReference}${v.dispatch.acknowledgedOn ? ` (${formatIsoDate(v.dispatch.acknowledgedOn)})` : ''}` : ''}</p>}
              <div className="mt-1 flex flex-wrap gap-2">
                <a className={buttonClass} href={`/api/rcm/submissions/${v.id}/copy/rcm`}>Download RCM copy</a>
                <a className={secondaryButtonClass} href={`/api/rcm/submissions/${v.id}/copy/insurer`}>Download insurer copy</a>
                <Verify submissionId={v.id} />
              </div>
              {v.dispatch && v.dispatch.insurerReference === null && <Acknowledge dispatchId={v.dispatch.id} />}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
