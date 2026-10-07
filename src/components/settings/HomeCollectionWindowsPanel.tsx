'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { HomeCollectionWindowRow } from '@/db/schema'

const INPUT = 'rounded-md border border-border px-3 py-2 text-sm'

type WindowView = Pick<HomeCollectionWindowRow, 'id' | 'label' | 'startTime' | 'endTime' | 'capacity' | 'isActive' | 'sortOrder'>

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return res.status === 400 || res.status === 409 ? (body.error ?? fallback) : fallback
}

// SP5 Settings → Lab setup: home-collection windows (IST 'HH:MM', with a per-day capacity).
// Windows are never deleted, only deactivated; booked visits keep their own snapshot.
export function HomeCollectionWindowsPanel({ windows, isAdmin }: { windows: WindowView[]; isAdmin: boolean }) {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [startTime, setStartTime] = useState('07:00')
  const [endTime, setEndTime] = useState('09:00')
  const [capacity, setCapacity] = useState(10)
  const [capacityEdits, setCapacityEdits] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/home-collection-windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), startTime, endTime, capacity }),
      })
      if (!res.ok) { setError(await errorText(res, 'Could not add the window.')); return }
      setLabel('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function patch(w: WindowView, body: Record<string, unknown>) {
    setError(null)
    const res = await fetch(`/api/settings/home-collection-windows/${w.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { setError(await errorText(res, 'Could not update the window.')); return }
    setCapacityEdits((m) => { const next = { ...m }; delete next[w.id]; return next })
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Times are India Standard Time. Capacity is the number of home visits per window per day.</p>
      <ul className="divide-y divide-border">
        {windows.map((w) => {
          const edited = capacityEdits[w.id]
          return (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
              <div>
                <span className="font-medium text-foreground">{w.label}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{w.startTime}–{w.endTime}</span>
                {!isAdmin && <span className="ml-2 text-xs text-muted-foreground">{w.capacity} visits</span>}
                {!w.isActive && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Inactive</span>}
              </div>
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    aria-label={`Capacity for ${w.label}`}
                    value={edited ?? w.capacity}
                    onChange={(e) => setCapacityEdits((m) => ({ ...m, [w.id]: Number(e.target.value) }))}
                    className={`${INPUT} w-20 py-1`}
                  />
                  {edited !== undefined && edited !== w.capacity && (
                    <button onClick={() => patch(w, { capacity: edited })} className="text-xs font-medium text-primary hover:underline">Save</button>
                  )}
                  <button
                    onClick={() => patch(w, { isActive: !w.isActive })}
                    aria-label={`${w.isActive ? 'Deactivate' : 'Activate'} ${w.label}`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {w.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              )}
            </li>
          )
        })}
        {windows.length === 0 && <li className="py-2 text-sm text-muted-foreground">No collection windows yet.</li>}
      </ul>
      {isAdmin && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Window label" placeholder="Label, e.g. Morning" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} className={`${INPUT} min-w-0 flex-1`} />
            <input type="time" aria-label="Window start" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={INPUT} />
            <input type="time" aria-label="Window end" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={INPUT} />
            <input type="number" min={1} max={50} aria-label="Window capacity" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} className={`${INPUT} w-20`} />
          </div>
          <button onClick={add} disabled={busy || !label.trim()} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {busy ? 'Adding…' : 'Add window'}
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
