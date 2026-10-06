'use client'
import { useState } from 'react'
import { MfaEnrollStep } from '@/components/mfa/MfaEnrollStep'

export function PatientPortalSecurityPanel({ initialMfaEnabled }: { initialMfaEnabled: boolean }) {
  const [mfaEnabled, setMfaEnabled] = useState(initialMfaEnabled)
  const [enrollment, setEnrollment] = useState<{ qrDataUrl: string; manualKey: string } | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [showReset, setShowReset] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function startEnroll() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/patient-portal/account/mfa/enroll', { method: 'POST' })
    setBusy(false)
    if (!res.ok) { setError('Could not start enrollment.'); return }
    setEnrollment(await res.json())
  }

  async function confirmEnroll(code: string): Promise<string | null> {
    const res = await fetch('/api/patient-portal/account/mfa/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return body?.error ?? 'Could not confirm that code.'
    }
    setEnrollment(null)
    setMfaEnabled(true)
    return null
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/patient-portal/account/mfa/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: resetPassword }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not turn off two-factor authentication.')
      return
    }
    setMfaEnabled(false)
    setShowReset(false)
    setResetPassword('')
  }

  if (enrollment) {
    return <MfaEnrollStep qrDataUrl={enrollment.qrDataUrl} manualKey={enrollment.manualKey} onSubmit={confirmEnroll} />
  }

  return (
    <div className="rounded-2xl border border-primary/10 bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-foreground">Security</h1>
      <p className="mb-4 text-sm text-muted-foreground">Add a second step to your sign-in for extra protection.</p>

      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${mfaEnabled ? 'bg-success' : 'bg-muted-foreground'}`} aria-hidden="true" />
        <span className="text-foreground">{mfaEnabled ? 'Two-factor authentication is on' : 'Two-factor authentication is off'}</span>
      </div>

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {!mfaEnabled && !showReset && (
        <button onClick={startEnroll} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          Enable two-factor authentication
        </button>
      )}

      {mfaEnabled && !showReset && (
        <button onClick={() => setShowReset(true)} className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10">
          Turn off two-factor authentication
        </button>
      )}

      {showReset && (
        <form onSubmit={submitReset} className="space-y-3">
          <div>
            <label htmlFor="reset-password" className="mb-1 block text-xs font-medium text-muted-foreground">Confirm your password</label>
            <input
              id="reset-password"
              type="password"
              required
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              Turn off
            </button>
            <button type="button" onClick={() => setShowReset(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
