'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'

export function ConfirmEligibilityButton({ anonId }: { anonId: string }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    const res = await sendJson(`/api/patients/${anonId}/screening/confirm`, 'POST')
    if (!res.ok) {
      setRunning(false)
      setError(res.error)
      return
    }
    // A full reload rather than router.refresh() -- this page's data comes
    // from a Redis-cached query (getPatientDetail), and the freshly
    // confirmed selection only reliably shows up on a real navigation, not
    // a soft RSC refresh, in local testing against this app's dev server.
    window.location.reload()
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={run}
        disabled={running}
        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
      >
        {running ? 'Confirming…' : 'Confirm Eligibility & Notify Patient'}
      </button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
