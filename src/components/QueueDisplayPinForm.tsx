'use client'
import { useState } from 'react'

export function QueueDisplayPinForm({ isAdmin, configured }: { isAdmin: boolean; configured: boolean }) {
  const [pinConfigured, setPinConfigured] = useState(configured)
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    setSavedAt(null)
    const res = await fetch('/api/settings/queue-display-pin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    setSaving(false)
    if (!res.ok) { setError('Could not save the queue display PIN.'); return }
    setPinConfigured(true)
    setPin('')
    setSavedAt(Date.now())
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        This PIN gates the unauthenticated lobby queue display (<code>/display/queue</code>). Anyone with the PIN can view ticket numbers, urgency, and stage — never patient names or reasons.
      </p>
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">PIN configured</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${pinConfigured ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>
          {pinConfigured ? 'Yes' : 'No'}
        </span>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">New PIN</label>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          disabled={!isAdmin}
          placeholder={pinConfigured ? '•••••••••• (leave blank to keep current PIN)' : 'At least 4 characters'}
          className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
        />
      </div>
      {isAdmin && (
        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} disabled={!pin || pin.length < 4 || saving} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt && <span className="text-xs text-muted-foreground">Saved</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      )}
    </div>
  )
}
