'use client'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useBrand } from '@/components/BrandProvider'

export interface DeleteTarget {
  id: string
  name: string
}

/**
 * Controlled confirmation modal for permanently removing a patient chart --
 * shared by the Workbook's right-click menu and the Patient Detail page's
 * delete button so both go through the identical confirm step and DELETE
 * call. Deletes only the app's own copy (see api/patients/[anonId]
 * DELETE): the underlying EHR/intake-system record, if any, is untouched.
 */
export function DeletePatientDialog({ target, onClose, onDeleted }: { target: DeleteTarget | null; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { name: brandName } = useBrand()

  if (!target) return null

  async function confirmDelete() {
    if (!target) return
    setDeleting(true)
    setError(null)
    const res = await fetch(`/api/patients/${target.id}`, { method: 'DELETE' })
    setDeleting(false)
    if (!res.ok) {
      setError('Could not delete this patient. Please try again.')
      return
    }
    onClose()
    onDeleted()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">
              <Trash2 className="h-4.5 w-4.5" />
            </span>
            <DialogTitle className="text-lg font-semibold text-foreground">Delete patient record?</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This permanently removes <span className="font-medium text-foreground">{target.name}</span> ({target.id}) and every record tied to
          them -- diagnoses, medications, forms, appointments, messages, billing -- from {brandName}. It disappears from the Patients tab, the
          Workbook, and everywhere else in the app immediately. This does not affect their chart in your practice&apos;s EHR or intake system, and cannot be undone.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
