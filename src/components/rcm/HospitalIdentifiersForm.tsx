'use client'
import { useState } from 'react'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass } from './ui'

export function HospitalIdentifiersForm({ rohiniId, hfrId }: { rohiniId: string | null; hfrId: string | null }) {
  const [r, setR] = useState(rohiniId ?? '')
  const [h, setH] = useState(hfrId ?? '')
  const run = useRcmAction()
  const [saved, setSaved] = useState<'ok' | 'cleared' | null>(null)
  return (
    <Panel title="Hospital identifiers on claims">
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={async (e) => {
        e.preventDefault()
        setSaved(null)
        const rohiniId = r.trim() || null
        const hfrId = h.trim() || null
        const done = await run.send('/api/rcm/settings', 'PUT', { rohiniId, hfrId })
        if (done !== null) setSaved(!rohiniId && !hfrId ? 'cleared' : 'ok')
      }}>
        <Field label="ROHINI ID (13 digits)"><input className={inputClass} value={r} onChange={(e) => setR(e.target.value)} /></Field>
        <Field label="HFR facility ID (IN + 10 digits)"><input className={inputClass} value={h} onChange={(e) => setH(e.target.value)} /></Field>
        <div className="flex items-end"><button type="submit" className={buttonClass} disabled={run.busy}>Save</button></div>
      </form>
      <FormError error={run.error} />
      {saved && !run.error && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {saved === 'cleared' ? 'Both cleared: claims and NHCX checks are blocked until they are set.' : 'Saved. Claims and NHCX checks will use these identifiers.'}
        </p>
      )}
    </Panel>
  )
}
