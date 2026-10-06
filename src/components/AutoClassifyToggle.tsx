'use client'
import { useState } from 'react'

export function AutoClassifyToggle({ initialEnabled, isAdmin }: { initialEnabled: boolean; isAdmin: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [saving, setSaving] = useState(false)

  async function toggle() {
    const next = !enabled
    setSaving(true)
    const res = await fetch('/api/settings/auto-classify', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    setSaving(false)
    if (res.ok) setEnabled(next)
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
    </div>
  )
}
