'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'

// WS6 T10: rendered inside QueueDisplayCard (which shows the status) for a custom PIN.
export function QueueDisplayPinForm({ isAdmin, configured, onSaved }: { isAdmin: boolean; configured: boolean; onSaved?: () => void }) {
  const [pinConfigured, setPinConfigured] = useState(configured)
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    setSavedAt(null)
    const res = await sendJson('/api/settings/queue-display-pin', 'PUT', { pin })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    setPinConfigured(true)
    setPin('')
    setSavedAt(Date.now())
    onSaved?.()
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        This PIN gates the unauthenticated lobby queue display (<code>/display/queue</code>). Anyone with the PIN can view token numbers, urgency, stage, doctor and room — never patient names, UHIDs or reasons.
      </p>
      <div>
        <label htmlFor="queue-display-custom-pin" className="mb-1 block text-xs font-medium text-muted-foreground">New PIN</label>
        <input
          id="queue-display-custom-pin"
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          disabled={!isAdmin}
          placeholder={pinConfigured ? '•••••••••• (leave blank to keep current PIN)' : 'At least 6 characters'}
          className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
        />
      </div>
      {isAdmin && (
        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} disabled={!pin || pin.trim().length < 6 || saving} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt && <span className="text-xs text-muted-foreground">Saved</span>}
          {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
        </div>
      )}
    </div>
  )
}
