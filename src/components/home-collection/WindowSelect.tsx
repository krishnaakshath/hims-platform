'use client'
// SP5: collection-window picker for one IST date. Full and closed windows are listed but disabled.
import { useEffect, useState } from 'react'
import type { WindowAvailability } from '@/lib/queries/home-collections'
import { fetchAvailability } from '@/components/home-collection/api'

export const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

export function windowOptionLabel(w: WindowAvailability): string {
  const range = `${w.startTime}–${w.endTime}`
  if (w.closed) return `${w.label} (${range}) · closed`
  if (w.remaining === 0) return `${w.label} (${range}) · full`
  return `${w.label} (${range}) · ${w.remaining} left`
}

export function WindowSelect({ id, date, value, onChange }: { id: string; date: string; value: string; onChange: (v: string) => void }) {
  const [windows, setWindows] = useState<WindowAvailability[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    fetchAvailability(date).then((r) => {
      if (!live) return
      if (r.ok) { setWindows(r.data); setError(null) } else { setWindows([]); setError(r.error) }
    })
    return () => { live = false }
  }, [date])

  return (
    <div>
      <label htmlFor={id} className="block text-xs text-muted-foreground">Collection window</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={FIELD} aria-describedby={error ? `${id}-error` : undefined}>
        <option value="">{windows === null ? 'Loading windows…' : 'Pick a window'}</option>
        {(windows ?? []).map((w) => (
          <option key={w.windowId} value={String(w.windowId)} disabled={w.closed || w.remaining === 0}>{windowOptionLabel(w)}</option>
        ))}
      </select>
      {windows !== null && windows.length === 0 && !error && <p className="mt-1 text-xs text-muted-foreground">No collection windows are set up.</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
