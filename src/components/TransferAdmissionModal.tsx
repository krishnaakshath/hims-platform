'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { OVERRIDE_REASON_MIN, type WardGenderConflict } from '@/lib/inpatient/admission-rules'

interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function TransferAdmissionModal({ admissionId, availableRooms, onClose }: { admissionId: number; availableRooms: RoomOption[]; onClose: () => void }) {
  const router = useRouter()
  const [toRoomId, setToRoomId] = useState<number | ''>('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // WS3 T4: a 422 ward_gender_conflict for the chosen bed asks for an override reason (spec 3.1 item 10).
  const [conflict, setConflict] = useState<WardGenderConflict | null>(null)
  const [overrideReason, setOverrideReason] = useState('')

  async function submit() {
    setSubmitting(true)
    setError(null)
    const body = conflict ? { toRoomId, reason, wardGenderOverrideReason: overrideReason.trim() } : { toRoomId, reason }
    const res = await sendJson(`/api/inpatient/admissions/${admissionId}/transfer`, 'POST', body)
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const refusal = res.body as { code?: string; conflict?: WardGenderConflict } | undefined
    if (res.status === 422 && refusal?.code === 'ward_gender_conflict' && refusal.conflict) { setConflict(refusal.conflict); return }
    setError(res.error)
  }

  const canSubmit = toRoomId !== '' && Boolean(reason) && !submitting && (!conflict || overrideReason.trim().length >= OVERRIDE_REASON_MIN)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer Patient</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={toRoomId} onChange={(e) => { setToRoomId(e.target.value === '' ? '' : Number(e.target.value)); setConflict(null); setOverrideReason('') }} aria-label="New room" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a new room…</option>
            {availableRooms.map((r) => <option key={r.id} value={r.id}>{r.ward} — Room {r.roomNumber}, Bed {r.bedNumber}</option>)}
          </select>
          {availableRooms.length === 0 && <p className="text-sm text-warning">No rooms are currently available.</p>}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for transfer" aria-label="Reason" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {conflict && (
            <div className="space-y-1">
              <p className="text-sm font-medium text-warning">
                {conflict === 'opposite_sex'
                  ? 'This bed is in a ward for the other gender.'
                  : "The patient's gender is not recorded as male or female, and this bed is gender-restricted."}
              </p>
              <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} aria-label="Override reason" maxLength={300} rows={2}
                placeholder={`Why this bed? (at least ${OVERRIDE_REASON_MIN} characters)`} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Transfer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
