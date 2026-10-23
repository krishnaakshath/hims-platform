'use client'
import { useState } from 'react'
import { AUTH_ALERT, AUTH_CODE_INPUT, AUTH_PRIMARY_BUTTON, AUTH_QUIET_BUTTON } from '@/components/auth/auth-styles'

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
      <div className="mb-8">
        <h1 className="text-2xl font-semibold leading-8 tracking-[-0.015em] text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="mfa-code" className="mb-2 block text-[13px] font-medium leading-5 text-foreground">6-digit code</label>
          <input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className={AUTH_CODE_INPUT}
          />
        </div>
        {error && <div role="alert" className={AUTH_ALERT}>{error}</div>}
        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className={AUTH_PRIMARY_BUTTON}
        >
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className={AUTH_QUIET_BUTTON}>
            Back
          </button>
        )}
      </form>
    </div>
  )
}
