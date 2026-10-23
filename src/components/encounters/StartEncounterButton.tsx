'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'

// WS1 T3 (spec ruling 2): the one way a visit moves to "in consultation". POSTs the start, then
// opens the workspace; the workspace GET itself never changes the visit.
export function StartEncounterButton({ encounterId, label = 'Start Encounter', className }: { encounterId: number; label?: string; className?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/encounters/${encounterId}/start`, 'POST', {})
    if (!res.ok) {
      setBusy(false)
      setError(res.error)
      return
    }
    router.push(`/encounters/${encounterId}`)
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className={className ?? 'rounded bg-success/10 px-2.5 py-1 text-xs font-bold text-success hover:bg-success/20 disabled:opacity-60'}
      >
        {busy ? 'Starting…' : label}
      </button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  )
}
