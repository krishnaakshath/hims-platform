'use client'
import { useState } from 'react'

// Shared by staff login (verify mode), patient login (verify mode), and the
// patient portal's Security page (confirming a fresh enrollment) -- one
// "enter your 6-digit code" form instead of three near-duplicates.
export function MfaCodeStep({ title, description, onSubmit, onBack }: {
  title: string
  description: string
  onSubmit: (code: string) => Promise<string | null> // resolves to an error message, or null on success
  onBack?: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const err = await onSubmit(code)
    setSubmitting(false)
    if (err) {
      setError(err)
      setCode('')
    }
  }

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="text-xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="mfa-code" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">6-digit code</label>
          <input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-center text-lg tracking-[0.5em] text-foreground focus:border-primary focus:outline-none"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className="w-full text-center text-xs font-medium text-muted-foreground hover:text-foreground">
            Back
          </button>
        )}
      </form>
    </div>
  )
}
