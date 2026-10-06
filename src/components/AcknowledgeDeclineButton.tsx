'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const FALLBACK_ERROR = 'Could not mark this decline handled.'

export function AcknowledgeDeclineButton({ assignmentId }: { assignmentId: number }) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch(`/api/front-desk/assignments/${assignmentId}/acknowledge-decline`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? FALLBACK_ERROR)
        return
      }
      // The nav badge (computed in the dashboard layout) and this row's
      // "Handled by" label both come from server data, so refresh re-renders
      // them without a full page reload.
      router.refresh()
    } catch {
      // Network failure: fetch itself rejected.
      setError(FALLBACK_ERROR)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
      >
        Mark handled
      </button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}
