'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ImagingAttachmentStrip, type AttachmentView } from '@/components/ImagingAttachmentStrip'

type Flag = 'normal' | 'abnormal' | 'critical'

export function EnterLabResultModal({
  orderId,
  testName,
  defaultUnit,
  defaultReferenceRange,
  category,
  attachments,
  onClose,
}: {
  orderId: number
  testName: string
  defaultUnit: string | null
  defaultReferenceRange: string | null
  category: 'lab' | 'imaging'
  attachments: AttachmentView[]
  onClose: () => void
}) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [unit, setUnit] = useState(defaultUnit ?? '')
  const [referenceRange, setReferenceRange] = useState(defaultReferenceRange ?? '')
  const [flag, setFlag] = useState<Flag>('normal')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/lab-orders/${orderId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value,
        ...(unit ? { unit } : {}),
        ...(referenceRange ? { referenceRange } : {}),
        flag,
        ...(notes ? { notes } : {}),
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not save this result.')
  }

  const canSubmit = Boolean(value.trim()) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enter Result — {testName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {category === 'imaging' && <ImagingAttachmentStrip attachments={attachments} />}
          {category === 'imaging' ? (
            <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="Impression" aria-label="Impression" rows={3} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Result value" aria-label="Result value" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          )}
          {category === 'lab' && (
            <div className="grid grid-cols-2 gap-2">
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" aria-label="Unit" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
              <input value={referenceRange} onChange={(e) => setReferenceRange(e.target.value)} placeholder="Reference range" aria-label="Reference range" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
          )}
          <select value={flag} onChange={(e) => setFlag(e.target.value as Flag)} aria-label="Flag" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="normal">Normal</option>
            <option value="abnormal">Abnormal</option>
            <option value="critical">Critical</option>
          </select>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" rows={2} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save result</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
