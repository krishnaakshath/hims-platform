'use client'
import { useState } from 'react'

// Lost-device recovery while still holding a trusted, signed-in session --
// re-enters the same email+password a fresh login would check. Works for
// admin too (see api/account/mfa/reset), so there's no separate "admin
// recovers admin" mechanism needed.
export function StaffMfaSelfResetForm({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/account/mfa/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not reset MFA.')
      return
    }
    setDone(true)
    setOpen(false)
  }

  if (done) {
    return <p className="text-xs text-muted-foreground">MFA has been reset. You&apos;ll set it up again next time you sign in.</p>
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary">
        Reset my MFA
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
      <div>
        <label htmlFor="self-reset-password" className="mb-1 block text-xs font-medium text-muted-foreground">Confirm your password</label>
        <input
          id="self-reset-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          Reset MFA
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
      </div>
    </form>
  )
}
