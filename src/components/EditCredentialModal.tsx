'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface EditableCredential {
  id: number
  staffMemberId: number
  credentialType: string
  credentialNumber: string | null
  expiresOn: string | null
}

// Fix B (final whole-branch review, Important #2): closest precedent is
// AddCredentialModal -- same Dialog-modal pattern, same
// fetch-then-router.refresh()-then-onClose flow, pre-filled with the
// current row since this is an edit, not a create. Calls the new
// PATCH /api/staff/[id]/credentials/[credentialId] route.
export function EditCredentialModal({ credential, onClose }: { credential: EditableCredential; onClose: () => void }) {
  const router = useRouter()
  const [credentialType, setCredentialType] = useState(credential.credentialType)
  const [credentialNumber, setCredentialNumber] = useState(credential.credentialNumber ?? '')
  const [expiresOn, setExpiresOn] = useState(credential.expiresOn ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/staff/${credential.staffMemberId}/credentials/${credential.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentialType,
        credentialNumber: credentialNumber.trim() ? credentialNumber : null,
        expiresOn: expiresOn ? expiresOn : null,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not update this credential.')
  }

  const canSubmit = Boolean(credentialType.trim()) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Credential</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={credentialType} onChange={(e) => setCredentialType(e.target.value)} placeholder="Credential type, e.g. RN License" aria-label="Credential type" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={credentialNumber} onChange={(e) => setCredentialNumber(e.target.value)} placeholder="Credential number (optional)" aria-label="Credential number" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Expiry date (optional)</label>
            <input value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} type="date" aria-label="Expiry date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
