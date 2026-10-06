'use client'
import { useState } from 'react'

const TIMEZONES = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York']

export function PracticeInfoForm({ initial, isAdmin }: {
  initial: { practiceName: string | null; practiceSite: string | null; practiceTimezone: string | null }
  isAdmin: boolean
}) {
  const [practiceName, setPracticeName] = useState(initial.practiceName ?? '')
  const [practiceSite, setPracticeSite] = useState(initial.practiceSite ?? '')
  const [practiceTimezone, setPracticeTimezone] = useState(initial.practiceTimezone ?? 'America/Los_Angeles')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/settings/practice-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ practiceName, practiceSite, practiceTimezone }),
    })
    setSaving(false)
    if (!res.ok) { setError('Could not save practice information.'); return }
    setSavedAt(Date.now())
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Practice name</label>
        <input value={practiceName} onChange={(e) => setPracticeName(e.target.value)} disabled={!isAdmin} placeholder="Your practice name" className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Site / location</label>
        <input value={practiceSite} onChange={(e) => setPracticeSite(e.target.value)} disabled={!isAdmin} placeholder="Redlands, CA" className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Timezone</label>
        <select value={practiceTimezone} onChange={(e) => setPracticeTimezone(e.target.value)} disabled={!isAdmin} className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60">
          {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
        </select>
      </div>
      {isAdmin && (
        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} disabled={saving} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt && <span className="text-xs text-muted-foreground">Saved</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      )}
    </div>
  )
}
