'use client'
import { useState } from 'react'
import { useRcmAction } from './useRcmAction'
import { FormError, secondaryButtonClass } from './ui'

export const CARD_UPLOAD_WARNING = 'Do not upload national ID cards here.'

export function PolicyCardUpload({ policyId }: { policyId: number }) {
  const [side, setSide] = useState<'front' | 'back'>('front')
  const run = useRcmAction()
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">{CARD_UPLOAD_WARNING}</p>
      <div className="flex items-center gap-2">
        <select aria-label="Card side" className="rounded border border-border bg-background px-1 py-0.5" value={side} onChange={(e) => setSide(e.target.value as typeof side)}><option value="front">Front</option><option value="back">Back</option></select>
        <label className={secondaryButtonClass}>Upload card image
          <input type="file" className="hidden" accept="application/pdf,image/jpeg,image/png" onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return
            const f = new FormData(); f.set('side', side); f.set('file', file)
            await run.upload(`/api/rcm/policies/${policyId}/card`, f)
          }} />
        </label>
      </div>
      <FormError error={run.error} />
    </div>
  )
}
