'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const MEDICATION_FORMS = ['tablet', 'capsule', 'liquid', 'injection', 'other'] as const

export function AddMedicationModal({
  initialName,
  initialClass,
  onClose,
}: {
  initialName?: string
  initialClass?: string
  onClose: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState(initialName ?? '')
  const [genericName, setGenericName] = useState('')
  const [medicationClass, setMedicationClass] = useState(initialClass ?? '')
  const [commonDose, setCommonDose] = useState('')
  const [form, setForm] = useState<(typeof MEDICATION_FORMS)[number]>('tablet')
  const [quantityOnHand, setQuantityOnHand] = useState('')
  const [reorderThreshold, setReorderThreshold] = useState('')
  const [unit, setUnit] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/pharmacy/medications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(genericName ? { genericName } : {}),
        medicationClass,
        ...(commonDose ? { commonDose } : {}),
        form,
        quantityOnHand: Number(quantityOnHand),
        reorderThreshold: Number(reorderThreshold),
        unit,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not add this medication.')
  }

  const parsedQuantity = Number(quantityOnHand)
  const parsedThreshold = Number(reorderThreshold)
  const canSubmit =
    name.trim() !== '' &&
    medicationClass.trim() !== '' &&
    unit.trim() !== '' &&
    quantityOnHand !== '' && Number.isInteger(parsedQuantity) && parsedQuantity >= 0 &&
    reorderThreshold !== '' && Number.isInteger(parsedThreshold) && parsedThreshold >= 0 &&
    !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add medication to catalog</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            aria-label="Name"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <input
            value={genericName}
            onChange={(e) => setGenericName(e.target.value)}
            placeholder="Generic name (optional)"
            aria-label="Generic name"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <input
            value={medicationClass}
            onChange={(e) => setMedicationClass(e.target.value)}
            placeholder="Medication class"
            aria-label="Medication class"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <input
            value={commonDose}
            onChange={(e) => setCommonDose(e.target.value)}
            placeholder="Common dose (optional)"
            aria-label="Common dose"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <select
            value={form}
            onChange={(e) => setForm(e.target.value as (typeof MEDICATION_FORMS)[number])}
            aria-label="Form"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          >
            {MEDICATION_FORMS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <input type="number" min={0} step={1} value={quantityOnHand} onChange={(e) => setQuantityOnHand(e.target.value)} placeholder="Quantity on hand" aria-label="Quantity on hand" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input type="number" min={0} step={1} value={reorderThreshold} onChange={(e) => setReorderThreshold(e.target.value)} placeholder="Reorder threshold" aria-label="Reorder threshold" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit, e.g. tablets" aria-label="Unit" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Add medication</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
