'use client'
import { useState } from 'react'

export function MfaMethodPicker({ email, currentMethod, currentPhone }: { email: string; currentMethod: 'totp' | 'sms' | 'email'; currentPhone: string | null }) {
  const [method, setMethod] = useState(currentMethod)
  const [phone, setPhone] = useState(currentPhone ?? '')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    const res = await fetch('/api/account/mfa-method', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, email, password, ...(method === 'sms' && phone ? { phone } : {}) }),
    })
    setSaving(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not switch your MFA method.')
      return
    }
    setSaved(true)
    setPassword('')
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Verification method</p>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1.5"><input type="radio" name="mfaMethod" checked={method === 'totp'} onChange={() => setMethod('totp')} /> Authenticator app</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="mfaMethod" checked={method === 'sms'} onChange={() => setMethod('sms')} /> Text message</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="mfaMethod" checked={method === 'email'} onChange={() => setMethod('email')} /> Email</label>
      </div>
      {method === 'sms' && (
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone number, e.g. +15551234567"
          aria-label="Phone number"
          className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
        />
      )}
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Confirm your password"
        aria-label="Confirm your password"
        className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {saved && <p className="text-xs text-success">Saved — you&apos;ll use this method next time you sign in.</p>}
      <button onClick={save} disabled={saving || !password} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
