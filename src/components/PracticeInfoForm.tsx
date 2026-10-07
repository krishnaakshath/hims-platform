'use client'
import { useState } from 'react'
import { DEFAULT_PRACTICE_TIMEZONE, PRACTICE_TIMEZONES, isPracticeTimezone } from '@/lib/practice-timezones'

export function PracticeInfoForm({ initial, isAdmin }: {
  initial: { practiceName: string | null; practiceSite: string | null; practiceTimezone: string | null }
  isAdmin: boolean
}) {
  const [practiceName, setPracticeName] = useState(initial.practiceName ?? '')
  const [practiceSite, setPracticeSite] = useState(initial.practiceSite ?? '')
  // The stored zone is shown as-is (never silently swapped for another zone);
  // nothing stored means India Standard Time.
  const [practiceTimezone, setPracticeTimezone] = useState(initial.practiceTimezone || DEFAULT_PRACTICE_TIMEZONE)
  const legacyZone = initial.practiceTimezone && !isPracticeTimezone(initial.practiceTimezone) ? initial.practiceTimezone : null
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/practice-info', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName, practiceSite, practiceTimezone }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(typeof body?.error === 'string' && body.error !== 'Invalid payload' ? body.error : 'Could not save hospital information.')
        return
      }
      setSavedAt(Date.now())
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="practice-name" className="mb-1 block text-xs font-medium text-muted-foreground">Hospital name</label>
        <input id="practice-name" value={practiceName} onChange={(e) => setPracticeName(e.target.value)} disabled={!isAdmin} placeholder="Your hospital name" className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60" />
      </div>
      <div>
        <label htmlFor="practice-site" className="mb-1 block text-xs font-medium text-muted-foreground">Site / location</label>
        <input id="practice-site" value={practiceSite} onChange={(e) => setPracticeSite(e.target.value)} disabled={!isAdmin} placeholder="e.g. Pune, Maharashtra" className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60" />
      </div>
      <div>
        <label htmlFor="practice-timezone" className="mb-1 block text-xs font-medium text-muted-foreground">Time zone</label>
        <select id="practice-timezone" value={practiceTimezone} onChange={(e) => setPracticeTimezone(e.target.value)} disabled={!isAdmin} className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60">
          {legacyZone && <option value={legacyZone}>{legacyZone} (current, not supported)</option>}
          {PRACTICE_TIMEZONES.map((tz) => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
        </select>
        {legacyZone && <p className="mt-1 text-xs text-warning">The stored zone is not a supported hospital zone. Choose one (India Standard Time is the default) and save.</p>}
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
