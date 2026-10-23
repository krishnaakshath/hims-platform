'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { MedicationWithInventory } from '@/lib/queries/medications'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { expiryMonthLabel, isExpired, pickFefo } from '@/lib/pharmacy/fefo' // WS5 T5
import { formatPaise } from '@/lib/money'
import { todayIsoIn } from '@/lib/india-time'

export function DispenseMedicationModal({
  medication,
  onClose,
  initialPatientId,
  medicationEpisodeId,
  onDispensed,
  today = todayIsoIn(),
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
  today?: string // WS5 T5: IST business date deciding which batches are expired
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
  // WS5 T5: '' = FEFO (the server allocates); otherwise a picked batch id. Live batches only
  // (`batches` is already in FEFO order); expired ones are listed but cannot be picked.
  const [batchId, setBatchId] = useState('')
  const liveBatches = medication.batches.filter((b) => !b.writtenOff && b.quantityOnHand > 0)
  const fefoPick = liveBatches.length > 0 ? pickFefo(liveBatches, 1, today) : null
  const fefoBatch = fefoPick?.ok ? liveBatches.find((b) => b.id === fefoPick.allocations[0].batchId) : undefined
  const shownBatch = batchId ? liveBatches.find((b) => String(b.id) === batchId) : fefoBatch

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson('/api/pharmacy/dispense', 'POST', {
      patientId,
      medicationId: medication.id,
      quantity: Number(quantity),
      ...(notes ? { notes } : {}),
      ...(medicationEpisodeId !== undefined ? { medicationEpisodeId } : {}),
      ...(batchId ? { batchId: Number(batchId) } : {}),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onDispensed?.(); onClose(); return }
    setError(res.error)
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
          {liveBatches.length > 0 && (
            <div className="flex items-center gap-3">
              <select value={batchId} onChange={(e) => setBatchId(e.target.value)} aria-label="Batch" className="min-w-0 flex-1 rounded-md border border-border px-3 py-2 text-sm">
                <option value="">{fefoBatch ? `FEFO: ${fefoBatch.batchNo} · exp ${expiryMonthLabel(fefoBatch.expiryDate)}` : 'FEFO: no unexpired batch'}</option>
                {liveBatches.map((b) => (
                  <option key={b.id} value={b.id} disabled={isExpired(b, today)}>
                    {`${b.batchNo} · exp ${expiryMonthLabel(b.expiryDate)} · ${b.quantityOnHand} ${medication.unit}${isExpired(b, today) ? ' (expired)' : ''}`}
                  </option>
                ))}
              </select>
              {shownBatch && <span className="whitespace-nowrap text-sm text-muted-foreground">{shownBatch.mrpPerUnitPaise > 0 ? `MRP ${formatPaise(shownBatch.mrpPerUnitPaise)} per unit` : 'MRP not recorded'}</span>}
            </div>
          )}
          <input type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={`Quantity (${medication.unit})`} aria-label="Quantity" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" rows={2} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Dispense</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
