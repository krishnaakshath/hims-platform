'use client'
import { useState } from 'react'
import { formatUhid, isValidUhidPrefix } from '@/lib/uhid'

export function UhidPrefixForm({ initialPrefix, isAdmin }: { initialPrefix: string; isAdmin: boolean }) {
  const [prefix, setPrefix] = useState(initialPrefix)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const valid = isValidUhidPrefix(prefix)

  async function save() {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/settings/uhid-prefix', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix }),
    })
    setSaving(false)
    if (!res.ok) { setError('Could not save UHID prefix.'); return }
    setSavedAt(Date.now())
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="uhid-prefix" className="mb-1 block text-xs font-medium text-muted-foreground">UHID prefix</label>
        <input
          id="uhid-prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          disabled={!isAdmin}
          maxLength={6}
          className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          1-6 characters: capital letters and digits, starting with a letter. Changing the prefix affects new registrations only.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Sample: {valid ? <span className="font-mono text-foreground">{formatUhid(prefix, 1)}</span> : <span className="text-destructive">invalid prefix</span>}
      </p>
      {isAdmin && (
        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} disabled={saving || !valid} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt && <span className="text-xs text-muted-foreground">Saved</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      )}
    </div>
  )
}
