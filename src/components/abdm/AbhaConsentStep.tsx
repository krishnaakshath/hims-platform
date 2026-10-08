'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export type ConsentText = { text: string; sha256: string }

// Shows the consent text verbatim (S1 CRT_ABHA_102: the full text, before any
// national ID number is sent) and records who agreed. The server checks the
// SHA-256 against the text it would have shown.
export function AbhaConsentStep({ consent, busy, onAgree }: {
  consent: ConsentText
  busy: boolean
  onAgree: (givenBy: 'patient' | 'guardian') => void
}) {
  const [givenBy, setGivenBy] = useState<'patient' | 'guardian' | ''>('')
  return (
    <div className="space-y-3">
      <div
        role="document"
        aria-label="Consent text"
        className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-sm"
        data-testid="abha-consent-text"
      >
        {consent.text}
      </div>
      <fieldset className="space-y-1 text-sm">
        <legend className="sr-only">Who agrees</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="abha-consent-by" checked={givenBy === 'patient'} onChange={() => setGivenBy('patient')} />
          Patient agrees
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="abha-consent-by" checked={givenBy === 'guardian'} onChange={() => setGivenBy('guardian')} />
          Guardian agrees on the patient&apos;s behalf
        </label>
      </fieldset>
      <Button type="button" disabled={!givenBy || busy} onClick={() => givenBy && onAgree(givenBy)}>
        Record consent
      </Button>
    </div>
  )
}
