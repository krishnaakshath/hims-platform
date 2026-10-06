'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function TransferAdmissionModal({ admissionId, availableRooms, onClose }: { admissionId: number; availableRooms: RoomOption[]; onClose: () => void }) {
  const router = useRouter()
  const [toRoomId, setToRoomId] = useState<number | ''>('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toRoomId, reason }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not transfer this patient.')
  }

  const canSubmit = toRoomId !== '' && Boolean(reason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer Patient</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={toRoomId} onChange={(e) => setToRoomId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="New room" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a new room…</option>
            {availableRooms.map((r) => <option key={r.id} value={r.id}>{r.ward} — Room {r.roomNumber}, Bed {r.bedNumber}</option>)}
          </select>
          {availableRooms.length === 0 && <p className="text-sm text-warning">No rooms are currently available.</p>}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for transfer" aria-label="Reason" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Transfer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
