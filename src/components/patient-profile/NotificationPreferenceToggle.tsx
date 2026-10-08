'use client'
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'
import { useRouter } from 'next/navigation'

// SP5: staff (NOTIFICATION_PREFERENCE_ROLES) switch a patient's lab and home-collection
// notices on or off. An opted-out patient still gets a delivery-log row, never a message.
export function NotificationPreferenceToggle({ anonId, initialOptOut }: { anonId: string; initialOptOut: boolean }) {
  const router = useRouter()
  const [optOut, setOptOut] = useState(initialOptOut)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    const next = !optOut
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/patients/${encodeURIComponent(anonId)}/notification-preference`, 'PUT', { optOut: next })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setOptOut(next)
    router.refresh()
  }

  const on = !optOut
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Send lab and home-collection notices"
          disabled={busy}
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted'}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} aria-hidden="true" />
        </button>
        <span className="text-sm text-foreground">{on ? 'Lab and home-collection notices are on' : 'Patient has opted out of notices'}</span>
      </div>
      <p className="text-xs text-muted-foreground">Notices carry only the hospital name, dates and collection windows, never test names or results.</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
