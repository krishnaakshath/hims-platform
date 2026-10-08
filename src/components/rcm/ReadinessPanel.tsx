'use client'
import { useState } from 'react'
import type { ClaimDocumentKind } from '@/lib/rcm/constants'
import type { ReadinessItem } from '@/lib/rcm/readiness'
import { useRcmAction } from './useRcmAction'
import { FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

export function ReadinessPanel({ claimId, ready, items, editable }: { claimId: number; ready: boolean; items: ReadinessItem[]; editable: boolean }) {
  const sorted = [...items.filter((i) => i.severity === 'block'), ...items.filter((i) => i.severity === 'warn')]
  const [waiving, setWaiving] = useState<ClaimDocumentKind | null>(null)
  const [reason, setReason] = useState('')
  const action = useRcmAction()

  async function upload(kind: ClaimDocumentKind, file: File) {
    const form = new FormData()
    form.set('kind', kind)
    form.set('title', file.name.slice(0, 120) || kind)
    form.set('file', file)
    await action.upload(`/api/rcm/claims/${claimId}/documents`, form)
  }

  return (
    <Panel title={ready ? 'Ready to submit' : 'Not ready to submit'}>
      {sorted.length === 0 ? <p className="text-sm text-muted-foreground">Every check passes.</p> : (
        <ul className="space-y-2 text-sm">
          {sorted.map((i) => (
            <li key={`${i.code}-${i.message}`} data-severity={i.severity} className={`rounded-md p-2 ${i.severity === 'block' ? 'bg-red-500/10 text-red-800' : 'bg-amber-500/10 text-amber-800'}`}>
              <p>{i.message}</p>
              {editable && i.documentKind && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {i.documentKind === 'id_proof' ? <a href="#documents" className={secondaryButtonClass}>Upload in Documents (choose the ID type)</a> : (
                  <label className={secondaryButtonClass}>
                    Upload
                    <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" aria-label={`Upload ${i.message}`}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(i.documentKind!, f) }} />
                  </label>)}
                  {waiving === i.documentKind ? (
                    <>
                      <input className={`${inputClass} w-64`} placeholder="Why it is not needed" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Waiver reason" />
                      <button type="button" className={buttonClass} disabled={action.busy}
                        onClick={async () => { if (await action.send(`/api/rcm/claims/${claimId}/documents/waive`, 'POST', { kind: i.documentKind, reason })) { setWaiving(null); setReason('') } }}>Save waiver</button>
                    </>
                  ) : <button type="button" className={secondaryButtonClass} onClick={() => setWaiving(i.documentKind!)}>Waive</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormError error={action.error} />
    </Panel>
  )
}
