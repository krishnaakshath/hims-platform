'use client'
import { useState } from 'react'

export function PatientPortalAccessPanel({ anonId, initialConfigured, mfaEnabled, isAdmin }: { anonId: string; initialConfigured: boolean; mfaEnabled: boolean; isAdmin: boolean }) {
  const [configured, setConfigured] = useState(initialConfigured)
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mfaResetting, setMfaResetting] = useState(false)
  const [mfaWasReset, setMfaWasReset] = useState(false)

  async function generate() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/patients/${anonId}/portal-password`, { method: 'POST' })
    setBusy(false)
    if (!res.ok) { setError('Could not generate a portal password.'); return }
    const body = await res.json()
    setGeneratedPassword(body.password)
    setConfigured(true)
  }

  async function revoke() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/patients/${anonId}/portal-password`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) { setError('Could not revoke portal access.'); return }
    setConfigured(false)
    setGeneratedPassword(null)
  }

  async function resetMfa() {
    setMfaResetting(true)
    setError(null)
    const res = await fetch(`/api/patients/${anonId}/reset-mfa`, { method: 'POST' })
    setMfaResetting(false)
    if (!res.ok) { setError('Could not reset MFA.'); return }
    setMfaWasReset(true)
  }

  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">{configured ? 'Portal access is enabled for this patient.' : 'Portal access is not enabled for this patient.'}</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${configured ? 'bg-success' : 'bg-muted-foreground'}`} aria-hidden="true" />
        <span className="text-foreground">{configured ? 'Portal access enabled' : 'Portal access not enabled'}</span>
      </div>

      {generatedPassword && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <p className="mb-1 font-medium text-foreground">New portal password — share this with the patient now:</p>
          <p className="font-mono text-base text-primary">{generatedPassword}</p>
          <p className="mt-1 text-xs text-muted-foreground">This won&apos;t be shown again. Patient ID for login: {anonId}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={generate} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {configured ? 'Reset portal password' : 'Enable portal access'}
        </button>
        {configured && (
          <button onClick={revoke} disabled={busy} className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
            Revoke access
          </button>
        )}
        {mfaEnabled && !mfaWasReset && (
          <button onClick={resetMfa} disabled={mfaResetting} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
            {mfaResetting ? 'Resetting…' : 'Reset MFA'}
          </button>
        )}
      </div>
      {mfaWasReset && <p className="text-xs text-muted-foreground">MFA has been reset for this patient.</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
