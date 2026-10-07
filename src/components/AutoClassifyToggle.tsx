'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'

export function AutoClassifyToggle({ initialEnabled, isAdmin }: { initialEnabled: boolean; isAdmin: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    const next = !enabled
    setSaving(true)
    setError(null)
    const res = await sendJson('/api/settings/auto-classify', 'PUT', { enabled: next })
    setSaving(false)
    if (res.ok) setEnabled(next)
    else setError(res.error)
  }

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-foreground">Automatically classify patients once intake and chart data are complete</span>
      <button
        onClick={toggle}
        disabled={!isAdmin || saving}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${enabled ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'} disabled:opacity-50`}
      >
        {enabled ? 'On' : 'Off'}
      </button>
      {error && <span role="alert" className="ml-3 text-xs text-destructive">{error}</span>}
    </div>
  )
}
