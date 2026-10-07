'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'

interface DiagnosisOption { id: number; code: string; description: string }
// Only the fields this modal actually needs -- kept as its own narrow shape
// (not `PharmacyPatientView['dispenses'][number]`) so it doesn't drag in
// that type's `Date`-typed `dispensedAt`, which is already a string by the
// time it reaches here via `fetch().json()`.
interface DispenseForBilling { id: number; medicationName: string; quantity: number }

// The standard HCPCS "Unclassified drugs" code -- the right default for an
// in-office dispensed drug with no specific J-code. Validating a real code
// against a licensed code set is out of scope, same vendor boundary this
// codebase already accepts for CPT codes elsewhere.
const DEFAULT_PROCEDURE_CODE = 'J3490'

export function LogDispenseBillModal({
  dispense,
  diagnoses,
  onClose,
  onLogged,
}: {
  dispense: DispenseForBilling
  diagnoses: DiagnosisOption[]
  onClose: () => void
  onLogged?: () => void
}) {
  const [diagnosisId, setDiagnosisId] = useState<number | ''>('')
  const [procedureCode, setProcedureCode] = useState(DEFAULT_PROCEDURE_CODE)
  const [procedureDescription, setProcedureDescription] = useState(dispense.medicationName)
  const [unitCharge, setUnitCharge] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Rupees as typed -> integer paise (the API's unitChargeCents field holds paise).
  const unitChargeCents = parseRupeesToPaise(unitCharge) ?? 0
  const totalCents = dispense.quantity * unitChargeCents

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/pharmacy/dispenses/${dispense.id}/charge`, 'POST', {
      diagnosisId,
      procedureCode: procedureCode.trim(),
      procedureDescription: procedureDescription.trim(),
      unitChargeCents,
    })
    setSubmitting(false)
    if (res.ok) { onLogged?.(); onClose(); return }
    // Surfaced verbatim -- covers both the 400 validation messages and the
    // 409 "already billed" race message the route returns.
    setError(res.error)
  }

  const noDiagnoses = diagnoses.length === 0
  const canSubmit = !noDiagnoses && diagnosisId !== '' && procedureCode.trim() !== '' && procedureDescription.trim() !== '' && unitChargeCents > 0 && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Log bill for {dispense.medicationName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{dispense.quantity} unit{dispense.quantity === 1 ? '' : 's'} dispensed</p>

          {noDiagnoses ? (
            <p className="text-sm text-warning">No coded diagnosis on file — billing needs one</p>
          ) : (
            <select
              value={diagnosisId}
              onChange={(e) => setDiagnosisId(e.target.value === '' ? '' : Number(e.target.value))}
              aria-label="Diagnosis"
              className="w-full rounded-md border border-border px-3 py-2 text-sm"
            >
              <option value="">Select a diagnosis…</option>
              {diagnoses.map((d) => <option key={d.id} value={d.id}>{d.code} — {d.description}</option>)}
            </select>
          )}

          <input
            value={procedureCode}
            onChange={(e) => setProcedureCode(e.target.value)}
            placeholder="Procedure code"
            aria-label="Procedure code"
            disabled={noDiagnoses}
            className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          />
          <input
            value={procedureDescription}
            onChange={(e) => setProcedureDescription(e.target.value)}
            placeholder="Procedure description"
            aria-label="Procedure description"
            disabled={noDiagnoses}
            className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          />
          <input
            inputMode="decimal"
            value={unitCharge}
            onChange={(e) => setUnitCharge(e.target.value)}
            placeholder="Unit charge (₹)"
            aria-label="Unit charge in rupees"
            disabled={noDiagnoses}
            className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          />
          <p className="text-sm text-muted-foreground">Total (server-computed): {formatPaise(totalCents)}</p>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Log bill</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
