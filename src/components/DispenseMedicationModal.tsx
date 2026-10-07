'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { MedicationWithInventory } from '@/lib/queries/medications'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'

export function DispenseMedicationModal({
  medication,
  onClose,
  initialPatientId,
  medicationEpisodeId,
  onDispensed,
}: {
  medication: MedicationWithInventory
  onClose: () => void
  // Set only from the patient-lookup screen, where the chart is already
  // confirmed and looked up by id -- retyping the id at this point is a
  // dispensing-error opportunity, not a safety check, so the field is
  // rendered read-only rather than merely pre-filled.
  initialPatientId?: string
  medicationEpisodeId?: number
  onDispensed?: () => void
}) {
  const router = useRouter()
  // Wave C P0-04: from the stock table the patient is found with the
  // PatientPicker (name, UHID, mobile); from the lookup screen it is fixed.
  const [picked, setPicked] = useState<PickedPatient | null>(null)
  const patientId = initialPatientId ?? picked?.id ?? ''
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/pharmacy/dispense', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        medicationId: medication.id,
        quantity: Number(quantity),
        ...(notes ? { notes } : {}),
        ...(medicationEpisodeId !== undefined ? { medicationEpisodeId } : {}),
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onDispensed?.(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not dispense this medication.')
  }

  const parsedQuantity = Number(quantity)
  const canSubmit = Boolean(patientId) && quantity !== '' && Number.isInteger(parsedQuantity) && parsedQuantity > 0 && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dispense {medication.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{medication.quantityOnHand} {medication.unit} on hand</p>
          {initialPatientId ? (
            <input value={initialPatientId} readOnly aria-label="Patient" className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" />
          ) : (
            <PatientPicker value={picked} onChange={setPicked} />
          )}
          <input type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={`Quantity (${medication.unit})`} aria-label="Quantity" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" rows={2} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Dispense</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
