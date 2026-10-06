'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface PayerOption {
  id: number
  name: string
}

interface EligibilityResult {
  status: string
  copayCents: number | null
  deductibleRemainingCents: number | null
  planType: string | null
}

export function EligibilityCheckModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [payerId, setPayerId] = useState('')
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<EligibilityResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/payers')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPayerOptions(data))
      .catch(() => setPayerOptions([]))
  }, [])

  // Default the payer dropdown to the patient's own primary payer on file,
  // once a patient ID is entered -- without stomping on a payer the user
  // already picked for this session.
  async function lookupPatientDefaultPayer() {
    if (!patientId || payerId) return
    // Narrow lookup (admin/crc/billing): only the payer id, never the
    // clinical patient-detail JSON.
    const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}/primary-payer`)
    if (!res.ok) return
    const lookup = await res.json().catch(() => null)
    if (lookup?.primaryPayerId) setPayerId(String(lookup.primaryPayerId))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/front-desk/eligibility-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, payerId: Number(payerId) }),
    })
    setSubmitting(false)
    if (res.ok) { setResult(await res.json()); router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not verify eligibility.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Verify Insurance Eligibility</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} onBlur={lookupPatientDefaultPayer} placeholder="Anonymous #, e.g. RD-0001" aria-label="Patient ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <select value={payerId} onChange={(e) => setPayerId(e.target.value)} aria-label="Payer" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select payer…</option>
            {payerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {result && (
            <p className="rounded-md border border-border bg-secondary p-2 text-sm">
              Status: <span className="font-medium capitalize">{result.status.replace('_', ' ')}</span>
              {result.copayCents !== null && <> · Copay: ${(result.copayCents / 100).toFixed(2)}</>}
              {result.deductibleRemainingCents !== null && <> · Deductible remaining: ${(result.deductibleRemainingCents / 100).toFixed(2)}</>}
              {result.planType && <> · Plan: <span className="uppercase">{result.planType}</span></>}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={submit} disabled={submitting || !patientId || !payerId}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
