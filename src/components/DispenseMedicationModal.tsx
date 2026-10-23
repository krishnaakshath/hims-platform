'use client'
import { sendJson } from '@/lib/client-fetch'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { MedicationWithInventory } from '@/lib/queries/medications'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
// WS2 T8
import { formatPaise } from '@/lib/format'
import { pharmacyLinePrice } from '@/lib/billing/pharmacy-price'
import { allergyConflicts, type AllergyConflict, type AllergyInput } from '@/lib/prescriptions/allergy-check'

const INPUT = 'w-full rounded-md border border-border px-3 py-2 text-sm'

export function DispenseMedicationModal({
  medication,
  onClose,
  initialPatientId,
  medicationEpisodeId,
  onDispensed,
  prescribedQuantity,
  allergies,
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
  // WS2 T8: the prescribed quantity pre-fills the quantity; the active allergies drive the banner
  // (the server re-checks and answers 409 with its own conflicts either way).
  prescribedQuantity?: number | null
  allergies?: AllergyInput[]
}) {
  const router = useRouter()
  // Wave C P0-04: from the stock table the patient is found with the
  // PatientPicker (name, UHID, mobile); from the lookup screen it is fixed.
  const [picked, setPicked] = useState<PickedPatient | null>(null)
  const patientId = initialPatientId ?? picked?.id ?? ''
  const [quantity, setQuantity] = useState(prescribedQuantity ? String(prescribedQuantity) : '')
  const [notes, setNotes] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expiryMonth, setExpiryMonth] = useState('')
  const [noCharge, setNoCharge] = useState(false)
  const [noChargeReason, setNoChargeReason] = useState('')
  // A 409's conflicts and the acknowledgement belong to one patient and one medicine: both are
  // keyed, so changing either drops them (a stale banner or tick must never carry over).
  const subjectKey = `${patientId}|${medication.id}`
  const [ack, setAck] = useState<string | null>(null)
  const [server, setServer] = useState<{ key: string; conflicts: AllergyConflict[] } | null>(null)
  const acknowledged = ack === subjectKey
  const serverConflicts = server?.key === subjectKey ? server.conflicts : null
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ message: string; patientId: string; charged: boolean } | null>(null)

  const parsedQuantity = Number(quantity)
  const quantityValid = quantity !== '' && Number.isInteger(parsedQuantity) && parsedQuantity >= 1 && parsedQuantity <= 1000
  const priced = medication.mrpPerUnitPaise !== null
  const price = priced && quantityValid
    ? pharmacyLinePrice({ mrpPerUnitPaise: medication.mrpPerUnitPaise!, quantity: parsedQuantity, gstRateBp: medication.effectiveGstRateBp })
    : null

  const localConflicts = useMemo(() => allergyConflicts(medication, allergies ?? []), [medication, allergies])
  const conflicts = serverConflicts ?? localConflicts
  const charged = !noCharge

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson<{ id: number; message: string; charge: unknown }>('/api/pharmacy/dispense', 'POST', {
      patientId,
      medicationId: medication.id,
      quantity: parsedQuantity,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(medicationEpisodeId !== undefined ? { medicationEpisodeId } : {}),
      // Required for a charged dispense; recorded on a free one too when given.
      ...(batchNo.trim() && expiryMonth ? { batchNo: batchNo.trim(), expiryMonth } : {}),
      ...(!charged ? { noChargeReason: noChargeReason.trim() } : {}),
      ...(conflicts.length > 0 && acknowledged ? { allergyAcknowledged: true } : {}),
    })
    setSubmitting(false)
    if (res.ok) {
      setDone({ message: res.data.message, patientId, charged: res.data.charge !== null })
      router.refresh()
      onDispensed?.()
      return
    }
    const body = res.body as { code?: string; conflicts?: AllergyConflict[] } | undefined
    if (body?.code === 'allergy_conflict' && Array.isArray(body.conflicts)) {
      setServer({ key: subjectKey, conflicts: body.conflicts })
      setAck(null)
    }
    setError(res.error)
  }

  const canSubmit = Boolean(patientId) && quantityValid && !submitting
    && (charged ? priced && batchNo.trim() !== '' && expiryMonth !== '' : noChargeReason.trim().length >= 5)
    && (conflicts.length === 0 || acknowledged)

  if (done) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Dispensed</DialogTitle></DialogHeader>
          <p role="status" className="text-sm text-foreground">{done.message}</p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Done</Button>
            {done.charged && (
              <Link href={`/cash-desk?patientId=${encodeURIComponent(done.patientId)}`} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
                Bill now
              </Link>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

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
            <PatientPicker value={picked} onChange={(p) => { setPicked(p); setError(null) }} />
          )}

          {conflicts.length > 0 && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-semibold text-destructive">Allergy on record</p>
              <ul className="mt-1 list-disc pl-5 text-foreground">
                {conflicts.map((c) => <li key={c.allergen}>{c.allergen} ({c.severity})</li>)}
              </ul>
              <label className="mt-2 flex items-start gap-2 text-foreground">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAck(e.target.checked ? subjectKey : null)} className="mt-0.5" />
                I have checked this allergy with the prescriber and will dispense
              </label>
            </div>
          )}

          <input type="number" min={1} max={1000} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={`Quantity (${medication.unit})`} aria-label="Quantity" className={INPUT} />

          <div data-testid="dispense-price" className="rounded-md bg-muted/50 p-3 text-sm">
            {!priced ? (
              <p className="text-warning">This medicine has no price (MRP) set. Dispense it free of charge with a reason, or set its MRP on the Pharmacy page.</p>
            ) : price ? (
              <>
                <p className="text-muted-foreground">{formatPaise(medication.mrpPerUnitPaise!)} × {parsedQuantity} (MRP, GST included)</p>
                <p className="font-semibold text-foreground">Total {formatPaise(price.totalPaise)}{noCharge ? ' (not charged)' : ''}</p>
              </>
            ) : (
              <p className="text-muted-foreground">MRP {formatPaise(medication.mrpPerUnitPaise!)} per {medication.unit.replace(/s$/, '')}, GST included</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} maxLength={30} placeholder="Batch number" aria-label="Batch number" className={INPUT} />
            <input type="month" value={expiryMonth} onChange={(e) => setExpiryMonth(e.target.value)} aria-label="Expiry month" className={INPUT} />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={noCharge} onChange={(e) => setNoCharge(e.target.checked)} />
            Dispense free of charge
          </label>
          {noCharge && (
            <input value={noChargeReason} onChange={(e) => setNoChargeReason(e.target.value)} maxLength={200} placeholder="Reason for no charge (at least 5 characters)" aria-label="Reason for no charge" className={INPUT} />
          )}

          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Notes (optional)" aria-label="Notes" rows={2} className={INPUT} />
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
