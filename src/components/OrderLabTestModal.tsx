'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface LabTestOption {
  id: number
  name: string
  code: string
  defaultUnit: string | null
  referenceRange: string | null
  category: 'lab' | 'imaging'
}

// Reusable from any patient-chart context -- the caller (LabResultsSection's
// "Order Test" button) owns the trigger button and open/close state and
// passes this patient's id plus the test catalog (fetched server-side via
// listLabTests(), the same "prop-drilled reference data" shape as
// TransferAdmissionModal's `availableRooms`) as props.
export function OrderLabTestModal({ patientId, labTests, onClose }: { patientId: string; labTests: LabTestOption[]; onClose: () => void }) {
  const router = useRouter()
  const [labTestId, setLabTestId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/patients/${patientId}/lab-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labTestId }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not order this test.')
  }

  const canSubmit = labTestId !== '' && !submitting
  const labOptions = labTests.filter((t) => t.category === 'lab')
  const imagingOptions = labTests.filter((t) => t.category === 'imaging')

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Order Lab Test</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={labTestId} onChange={(e) => setLabTestId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Lab test" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a test…</option>
            {labOptions.length > 0 && (
              <optgroup label="Labs">
                {labOptions.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}
              </optgroup>
            )}
            {imagingOptions.length > 0 && (
              <optgroup label="Imaging">
                {imagingOptions.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}
              </optgroup>
            )}
          </select>
          {labTests.length === 0 && <p className="text-sm text-warning">No lab tests are available in the catalog.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Order test</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
