'use client'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'

// Purely presentational, controlled input widget -- it does NOT perform the
// fetch itself. The parent (DischargeAdmissionModal, SignConsentFormAction)
// owns the request/submitting/error state and passes onSign(typedName),
// submitting, and error down, matching how every other action-modal in this
// codebase owns its own fetch rather than delegating it to a sub-component.
export function SignatureCapture({
  attestationLabel,
  submitLabel = 'Sign',
  submitting = false,
  error = null,
  onSign,
}: {
  attestationLabel: string
  submitLabel?: string
  submitting?: boolean
  error?: string | null
  onSign: (typedName: string) => void
}) {
  const [typedName, setTypedName] = useState('')
  const [attested, setAttested] = useState(false)
  const canSubmit = typedName.trim().length > 0 && attested && !submitting
  // Unique per instance -- the patient portal forms list can render one
  // SignatureCapture per unsigned consent form (2+ seeded templates), so a
  // hardcoded id would duplicate across the DOM and make `<label htmlFor>`
  // focus the wrong input.
  const typedNameId = useId()

  return (
    <div className="space-y-2">
      <label htmlFor={typedNameId} className="block text-xs font-medium text-muted-foreground">
        Type your full legal name to sign
      </label>
      <input
        id={typedNameId}
        value={typedName}
        onChange={(e) => setTypedName(e.target.value)}
        placeholder="Full legal name"
        aria-label="Typed signature"
        className="w-full rounded-md border border-border px-3 py-2 text-sm"
      />
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} aria-label="Attestation" className="mt-0.5" />
        <span>{attestationLabel}</span>
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button size="sm" onClick={() => onSign(typedName.trim())} disabled={!canSubmit}>{submitLabel}</Button>
    </div>
  )
}
