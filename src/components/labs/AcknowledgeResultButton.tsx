'use client'
// WS4 T11: the doctor home's "Acknowledge" for a verified result on the doctor's own order
// (POST /api/lab-orders/[id]/acknowledge). A failure is always shown, never swallowed.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'

export function AcknowledgeResultButton({ orderId, testName }: { orderId: number; testName: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function acknowledge() {
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/lab-orders/${orderId}/acknowledge`, 'POST', {})
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setDone(true)
    router.refresh()
  }

  if (done) return <span className="text-[10px] font-bold uppercase text-success">Acknowledged</span>
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={acknowledge}
        disabled={busy}
        aria-label={`Acknowledge ${testName}`}
        className="rounded bg-primary/10 px-2 py-1 text-[10px] font-bold uppercase text-primary hover:bg-primary/20 disabled:opacity-50"
      >
        Acknowledge
      </button>
      {error && <span role="alert" className="max-w-[12rem] text-right text-[11px] text-destructive">{error}</span>}
    </span>
  )
}
