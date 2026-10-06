'use client'
import { useState } from 'react'
import Image from 'next/image'

export function MfaEnrollStep({ qrDataUrl, manualKey, onSubmit }: {
  qrDataUrl: string
  manualKey: string
  onSubmit: (code: string) => Promise<string | null>
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
      <div className="mb-4 text-center">
        <h1 className="text-xl font-bold text-foreground">Set up two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted-foreground">Scan this code with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
      </div>
      <div className="mb-4 flex justify-center">
        <Image src={qrDataUrl} alt="Scan with your authenticator app" width={180} height={180} className="rounded-lg border border-border" unoptimized />
      </div>
      <p className="mb-4 text-center text-xs text-muted-foreground">
        Can&apos;t scan it? Enter this key manually: <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground">{manualKey}</code>
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="mfa-enroll-code" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">6-digit code</label>
          <input
            id="mfa-enroll-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
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
          {submitting ? 'Confirming…' : 'Confirm and finish setup'}
        </button>
      </form>
    </div>
  )
}
