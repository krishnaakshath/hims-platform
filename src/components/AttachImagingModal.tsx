'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,application/pdf'

export function AttachImagingModal({
  orderId,
  testName,
  onClose,
}: {
  orderId: number
  testName: string
  onClose: () => void
}) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setFile(picked)
    // The name input defaults to the chosen file's name until the user
    // types their own -- once touched, picking a different file no longer
    // clobbers what they typed.
    if (picked && !nameTouched) setName(picked.name)
  }

  async function submit() {
    if (!file) return
    setSubmitting(true)
    setError(null)
    const fd = new FormData()
    fd.set('file', file)
    const trimmedName = name.trim()
    if (trimmedName && trimmedName !== file.name) fd.set('name', trimmedName)
    // No Content-Type header -- the browser sets the multipart boundary
    // itself, same as InsuranceCardUpload's fetch().
    const res = await fetch(`/api/lab-orders/${orderId}/imaging`, { method: 'POST', body: fd })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not attach this image.')
  }

  const canSubmit = Boolean(file) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach Image — {testName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input
            type="file"
            accept={ACCEPTED_TYPES}
            onChange={handleFileChange}
            aria-label="Imaging file"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <input
            value={name}
            onChange={(e) => { setNameTouched(true); setName(e.target.value) }}
            placeholder="Name"
            aria-label="Name"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Attach image</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
