'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SignatureCapture } from '@/components/SignatureCapture'

type Step = 'summary' | 'followup' | 'confirmation'

// 3-step flow following Headspace's appointment stepper
// (https://mobbin.com/screens/c9b2bbdc-2976-46da-ba9a-e23f662f3d7e) for
// steps 1-2, and Cal.com's confirmation card
// (https://mobbin.com/screens/9d826d23-ed7e-4ec6-9f7f-c2b23f7d8f2a) for
// step 3. All fields are collected across steps 1-2 and sent in a single
// API call when leaving step 2 -- never once per step.
export function DischargeAdmissionModal({ admissionId, onClose }: { admissionId: number; onClose: () => void }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('summary')
  const [dischargeDiagnosis, setDischargeDiagnosis] = useState('')
  const [dischargeDrugs, setDischargeDrugs] = useState('')
  const [dischargeDevices, setDischargeDevices] = useState('')
  const [dischargeDiet, setDischargeDiet] = useState('')
  const [dischargeSummaryNotes, setDischargeSummaryNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpTime, setFollowUpTime] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [followUpCreated, setFollowUpCreated] = useState(false)

  const summaryComplete = Boolean(dischargeDiagnosis && dischargeDrugs && dischargeDevices && dischargeDiet && dischargeSummaryNotes)

  async function submit(typedName: string) {
    setSubmitting(true)
    setError(null)
    let followUpStartsAt: string | undefined
    let followUpEndsAt: string | undefined
    if (followUpDate && followUpTime) {
      const start = new Date(`${followUpDate}T${followUpTime}`)
      followUpStartsAt = start.toISOString()
      followUpEndsAt = new Date(start.getTime() + 30 * 60 * 1000).toISOString()
    }
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/discharge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dischargeDiagnosis, dischargeDrugs, dischargeDevices, dischargeDiet, dischargeSummaryNotes, typedName, ...(followUpStartsAt ? { followUpStartsAt, followUpEndsAt } : {}) }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not discharge this patient.')
      return
    }
    const body = await res.json()
    setFollowUpCreated(Boolean(body.followUpAppointmentId))
    setStep('confirmation')
    router.refresh()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Discharge Patient</DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={step === 'summary' ? 'font-semibold text-foreground' : ''}>1. Discharge summary</span>
          <span>→</span>
          <span className={step === 'followup' ? 'font-semibold text-foreground' : ''}>2. Follow-up</span>
          <span>→</span>
          <span className={step === 'confirmation' ? 'font-semibold text-foreground' : ''}>3. Confirmation</span>
        </div>

        {step === 'summary' && (
          <div className="space-y-2">
            <input value={dischargeDiagnosis} onChange={(e) => setDischargeDiagnosis(e.target.value)} placeholder="Diagnosis" aria-label="Diagnosis" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={dischargeDrugs} onChange={(e) => setDischargeDrugs(e.target.value)} placeholder="Drugs (discharge medications)" aria-label="Drugs" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={dischargeDevices} onChange={(e) => setDischargeDevices(e.target.value)} placeholder="Devices (e.g. None, or Wound VAC)" aria-label="Devices" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={dischargeDiet} onChange={(e) => setDischargeDiet(e.target.value)} placeholder="Diet" aria-label="Diet" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <textarea value={dischargeSummaryNotes} onChange={(e) => setDischargeSummaryNotes(e.target.value)} placeholder="Discharge summary notes" aria-label="Discharge summary notes" className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={3} />
          </div>
        )}

        {step === 'followup' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Optional — schedule a follow-up with the attending provider.</p>
              <input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} aria-label="Follow-up date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
              <input type="time" value={followUpTime} onChange={(e) => setFollowUpTime(e.target.value)} aria-label="Follow-up time" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
            <SignatureCapture
              attestationLabel="I attest that this discharge summary is accurate and complete."
              submitLabel="Discharge"
              submitting={submitting}
              error={error}
              onSign={submit}
            />
          </div>
        )}

        {step === 'confirmation' && (
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-2 font-semibold text-success"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/15">✓</span> Patient discharged</p>
            <p className="text-muted-foreground">The room has been freed and marked for cleaning.</p>
            {followUpCreated && <p className="text-muted-foreground">A follow-up appointment was scheduled with the attending provider.</p>}
          </div>
        )}

        <DialogFooter>
          {step === 'summary' && (<>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => setStep('followup')} disabled={!summaryComplete}>Next</Button>
          </>)}
          {step === 'followup' && (
            <Button variant="outline" onClick={() => setStep('summary')}>Back</Button>
          )}
          {step === 'confirmation' && <Button onClick={onClose}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
