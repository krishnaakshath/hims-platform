'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { Button } from '@/components/ui/button'

// Wave J (P1-20): confirming a patient's portal cancellation request cancels the named
// appointment. Two clicks (Confirm, then Cancel appointment) so a stray click never cancels.
export function ConfirmCancelRequestButton({ requestId, appointmentId }: { requestId: number; appointmentId: number | null }) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/booking-requests/${requestId}/confirm`, 'PATCH', {})
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    router.refresh()
  }

  if (!armed) return <Button size="sm" onClick={() => setArmed(true)}>Confirm</Button>
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={confirm}>Cancel appointment{appointmentId ? ` #${appointmentId}` : ''}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArmed(false)}>Back</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
