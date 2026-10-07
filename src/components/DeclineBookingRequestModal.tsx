'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'

export function DeclineBookingRequestModal({ request, onClose }: {
  request: BookingRequestRow
  onClose: () => void
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/booking-requests/${request.id}/decline`, 'PATCH', { reason })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  const canSubmit = Boolean(reason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Decline Booking Request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{request.requesterName} · {request.reason}</p>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for declining" aria-label="Reason" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={!canSubmit}>Decline</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
