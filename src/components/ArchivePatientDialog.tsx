'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Archive } from 'lucide-react'
import { sendJson } from '@/lib/client-fetch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'

// WS8 T13 (spec D17): archive replaces delete. Shared by the patient page's "More" menu and the
// Workbook. The admin types the patient's UHID and a reason of at least 10 characters; the chart
// and its records are kept, and an admin can restore it from the chart.
const REASON_MIN = 10
const REASON_MAX = 500

export interface ArchiveTarget {
  id: string
  name: string
  /** Shown as the value to type when known; a legacy chart without a UHID is confirmed by its chart id. */
  uhid?: string | null
}

export function ArchivePatientDialog({ target, onClose, onArchived }: { target: ArchiveTarget | null; onClose: () => void; onArchived: () => void }) {
  const [confirmUhid, setConfirmUhid] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const uhidId = useId()
  const reasonId = useId()

  if (!target) return null

  const reasonLength = reason.trim().length
  const canSubmit = confirmUhid.trim().length > 0 && reasonLength >= REASON_MIN && reasonLength <= REASON_MAX && !saving
  const confirmHint = target.uhid ? <>Type <span className="font-mono font-medium text-foreground">{target.uhid}</span> to confirm.</> : <>Type the patient&apos;s UHID to confirm.</>

  function close() {
    setConfirmUhid('')
    setReason('')
    setError(null)
    onClose()
  }

  async function confirmArchive() {
    if (!target || !canSubmit) return
    setSaving(true)
    setError(null)
    const res = await sendJson(`/api/patients/${encodeURIComponent(target.id)}/archive`, 'POST', { reason: reason.trim(), confirmUhid: confirmUhid.trim() })
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    close()
    onArchived()
    // WS7 T16: archiving is admin-only, so the admin always gets the way back. The toast's action is a
    // link, so "Undo" opens the archived chart, whose banner restores it in one click (the restore route).
    toast.show({ title: 'Archived', description: `${target.name} is hidden from lists and search.`, action: { label: 'Undo', href: `/patients/${encodeURIComponent(target.id)}` } })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
              <Archive className="h-4.5 w-4.5" />
            </span>
            <DialogTitle className="text-lg font-semibold text-foreground">Archive patient chart?</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{target.name}</span> will be hidden from patient lists, search, pickers,
          broadcasts, the queue and portal sign-in. Every record is kept, and an administrator can restore the chart.
        </p>
        <div className="space-y-1">
          <label htmlFor={uhidId} className="text-sm font-medium text-foreground">UHID</label>
          <p className="text-xs text-muted-foreground">{confirmHint}</p>
          <Input id={uhidId} value={confirmUhid} onChange={(e) => setConfirmUhid(e.target.value)} autoComplete="off" spellCheck={false} maxLength={64} />
        </div>
        <div className="space-y-1">
          <label htmlFor={reasonId} className="text-sm font-medium text-foreground">Reason</label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={REASON_MAX}
            rows={3}
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            aria-describedby={`${reasonId}-hint`}
          />
          <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">At least {REASON_MIN} characters.</p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>Cancel</Button>
          <Button onClick={confirmArchive} disabled={!canSubmit}>
            {saving ? 'Archiving…' : 'Archive patient'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The archived-chart banner's Restore action (admin only; the page renders it only for admin). */
export function RestorePatientButton({ patientId }: { patientId: string }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    setSaving(true)
    setError(null)
    const res = await sendJson(`/api/patients/${encodeURIComponent(patientId)}/restore`, 'POST', {})
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" onClick={restore} disabled={saving}>{saving ? 'Restoring…' : 'Restore patient'}</Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
