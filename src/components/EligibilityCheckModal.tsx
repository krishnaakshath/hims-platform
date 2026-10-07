'use client'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/format'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'

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
  // Wave C P0-04: picked by name, UHID or mobile; the routes get the chart id.
  const [patient, setPatient] = useState<PickedPatient | null>(null)
  const patientId = patient?.id ?? ''
  const [payerId, setPayerId] = useState('')
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<EligibilityResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/payers')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPayerOptions(data))
      .catch(() => { setPayerOptions([]); setError('Could not load the payer list. Close this and try again.') })
  }, [])

  // Default the payer dropdown to the patient's own primary payer on file,
  // once a patient is picked -- without stomping on a payer the user
  // already picked for this session.
  async function lookupPatientDefaultPayer(id: string) {
    if (!id || payerId) return
    // Narrow lookup (admin/crc/billing): only the payer id, never the
    // clinical patient-detail JSON.
    const res = await fetchJson<{ primaryPayerId?: number | null } | null>(`/api/patients/${encodeURIComponent(id)}/primary-payer`)
    if (!res.ok) return
    const lookup = res.data
    if (lookup?.primaryPayerId) setPayerId(String(lookup.primaryPayerId))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson('/api/front-desk/eligibility-check', 'POST', { patientId, payerId: Number(payerId) })
    setSubmitting(false)
    if (res.ok) { setResult(res.data as EligibilityResult); router.refresh(); return }
    setError(res.error)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Verify Insurance Eligibility</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <PatientPicker value={patient} onChange={(p) => { setPatient(p); setResult(null); if (p) void lookupPatientDefaultPayer(p.id) }} />
          <select value={payerId} onChange={(e) => setPayerId(e.target.value)} aria-label="Payer" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select payer…</option>
            {payerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {result && (
            <p className="rounded-md border border-border bg-secondary p-2 text-sm">
              Status: <span className="font-medium capitalize">{result.status.replace('_', ' ')}</span>
              {result.copayCents !== null && <> · Co-pay: {formatPaise(result.copayCents)}</>}
              {result.deductibleRemainingCents !== null && <> · Deductible remaining: {formatPaise(result.deductibleRemainingCents)}</>}
              {result.planType && <> · Plan: <span className="uppercase">{result.planType}</span></>}
            </p>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={submit} disabled={submitting || !patientId || !payerId}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
