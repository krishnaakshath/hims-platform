'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function AddCredentialModal({ staffMemberId, onClose }: { staffMemberId: number; onClose: () => void }) {
  const router = useRouter()
  const [credentialType, setCredentialType] = useState('')
  const [credentialNumber, setCredentialNumber] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/staff/${staffMemberId}/credentials`, 'POST', {
      credentialType,
      credentialNumber: credentialNumber.trim() ? credentialNumber : null,
      expiresOn: expiresOn ? expiresOn : null,
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  const canSubmit = Boolean(credentialType.trim()) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Credential</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={credentialType} onChange={(e) => setCredentialType(e.target.value)} placeholder="Credential type, e.g. RN License" aria-label="Credential type" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={credentialNumber} onChange={(e) => setCredentialNumber(e.target.value)} placeholder="Credential number (optional)" aria-label="Credential number" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Expiry date (optional)</label>
            <input value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} type="date" aria-label="Expiry date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Add Credential</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
