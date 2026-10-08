'use client'
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'
import { useRouter } from 'next/navigation'
import type { ServiceAreaPinRow } from '@/db/schema'

const INPUT = 'rounded-md border border-border px-3 py-2 text-sm'

type PinView = Pick<ServiceAreaPinRow, 'id' | 'pinCode' | 'areaLabel' | 'isActive'>

// SP5 Settings → Lab setup: the PIN codes the lab collects from at home ("local patient",
// Ruling 3). Admin only edits; everyone else sees the list.
export function LabServiceAreaPanel({ pins, isAdmin }: { pins: PinView[]; isAdmin: boolean }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [areaLabel, setAreaLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  async function add() {
    setBusy(true)
    setError(null)
    setStatus(null)
    type Saved = { added?: number; reactivated?: number; unchanged?: number }
    const res = await sendJson<Saved | null>('/api/settings/lab-service-area', 'POST', { pins: text, ...(areaLabel.trim() ? { areaLabel: areaLabel.trim() } : {}) })
    setBusy(false)
    if (!res.ok) {
      // The route lists the rejected PIN codes (the admin's own input, echoed to the admin only).
      const invalid = (res.body as { invalid?: unknown } | undefined)?.invalid
      setError(res.status === 400 && Array.isArray(invalid) && invalid.length ? `${res.error}: ${invalid.join(', ')}` : res.error)
      return
    }
    const body = res.data ?? {}
    setStatus(`Added ${body.added ?? 0}, reactivated ${body.reactivated ?? 0}, already listed ${body.unchanged ?? 0}.`)
    setText('')
    setAreaLabel('')
    router.refresh()
  }

  async function toggle(p: PinView) {
    setError(null)
    setStatus(null)
    const res = await sendJson(`/api/settings/lab-service-area/${p.id}`, 'PATCH', { isActive: !p.isActive })
    if (!res.ok) { setError(res.error); return }
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Patients whose collection address is in one of these active PIN codes can book home sample collection. Everyone else is walk-in only.</p>
      <ul className="divide-y divide-border">
        {pins.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div>
              <span className="font-mono font-medium text-foreground">{p.pinCode}</span>
              {p.areaLabel && <span className="ml-2 text-xs text-muted-foreground">{p.areaLabel}</span>}
              {!p.isActive && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Inactive</span>}
            </div>
            {isAdmin && (
              <button
                onClick={() => toggle(p)}
                aria-label={`${p.isActive ? 'Deactivate' : 'Activate'} ${p.pinCode}`}
                className="text-xs font-medium text-primary hover:underline"
              >
                {p.isActive ? 'Deactivate' : 'Activate'}
              </button>
            )}
          </li>
        ))}
        {pins.length === 0 && <li className="py-2 text-sm text-muted-foreground">No PIN codes yet. Home collection is off until you add some.</li>}
      </ul>
      {isAdmin && (
        <div className="space-y-2 border-t border-border pt-4">
          <textarea
            aria-label="PIN codes"
            placeholder="Paste 6-digit PIN codes, separated by commas, spaces or new lines"
            value={text}
            maxLength={5000}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            className={`${INPUT} w-full font-mono`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Area label" placeholder="Area label (optional)" value={areaLabel} maxLength={80} onChange={(e) => setAreaLabel(e.target.value)} className={`${INPUT} min-w-0 flex-1`} />
            <button onClick={add} disabled={busy || !text.trim()} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {busy ? 'Saving…' : 'Add PIN codes'}
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
        </div>
      )}
      {!isAdmin && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
