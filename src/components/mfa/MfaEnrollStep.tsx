'use client'
import { useState } from 'react'
import { AUTH_ALERT, AUTH_CODE_INPUT, AUTH_PRIMARY_BUTTON } from '@/components/auth/auth-styles'
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
      <div className="mb-6">
        <h1 className="text-2xl font-semibold leading-8 tracking-[-0.015em] text-foreground">Set up two-factor authentication</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Scan this code with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
      </div>
      <div className="mb-5 flex justify-center rounded-lg border border-border bg-white p-4">
        <Image src={qrDataUrl} alt="Scan with your authenticator app" width={180} height={180} unoptimized />
      </div>
      <p className="mb-6 text-xs leading-5 text-muted-foreground">
        Can&apos;t scan it? Enter this key manually: <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground">{manualKey}</code>
      </p>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="mfa-enroll-code" className="mb-2 block text-[13px] font-medium leading-5 text-foreground">6-digit code</label>
          <input
            id="mfa-enroll-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
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
          {submitting ? 'Confirming…' : 'Confirm and finish setup'}
        </button>
      </form>
    </div>
  )
}
