'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SignatureCapture } from '@/components/SignatureCapture'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import { INTERVAL_UNITS, istSlotString, type IntervalUnit } from '@/lib/follow-ups/rules'

const SLOT_MINUTES = 30

/** `HH:MM` plus minutes on the same day, or null when it would cross midnight. */
function addMinutesToHhmm(hhmm: string, minutes: number): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes
  if (total >= 24 * 60) return null
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

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
  const [planTiming, setPlanTiming] = useState<'interval' | 'date'>('interval')
  const [planValue, setPlanValue] = useState('')
  const [planUnit, setPlanUnit] = useState<IntervalUnit>('weeks')
  const [planDate, setPlanDate] = useState('')
  const [planReason, setPlanReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [followUpCreated, setFollowUpCreated] = useState(false)
  const [followUpPlanned, setFollowUpPlanned] = useState(false)

  const summaryComplete = Boolean(dischargeDiagnosis && dischargeDrugs && dischargeDevices && dischargeDiet && dischargeSummaryNotes)

  async function submit(typedName: string) {
    setError(null)
    // The slot is composed in IST (+05:30), never the browser's local zone.
    let slot: { followUpStartsAt: string; followUpEndsAt: string } | null = null
    if (followUpDate && followUpTime) {
      const end = addMinutesToHhmm(followUpTime, SLOT_MINUTES)
      if (!end) {
        setError('The follow-up appointment must end by midnight. Pick an earlier time.')
        return
      }
      slot = { followUpStartsAt: istSlotString(followUpDate, followUpTime), followUpEndsAt: istSlotString(followUpDate, end) }
    }
    // The plan is sent only when a reason is entered.
    const reason = planReason.trim()
    let followUp: { timing: { kind: 'interval'; interval: { value: number; unit: IntervalUnit } } | { kind: 'date'; dueDate: string }; reason: string } | null = null
    if (reason) {
      if (planTiming === 'date') {
        if (!planDate) { setError('Pick the follow-up date, or clear the follow-up reason.'); return }
        followUp = { timing: { kind: 'date', dueDate: planDate }, reason }
      } else {
        const value = Number(planValue)
        if (!Number.isInteger(value) || value < 1) { setError('Enter how many days, weeks or months until the follow-up, or clear the follow-up reason.'); return }
        followUp = { timing: { kind: 'interval', interval: { value, unit: planUnit } }, reason }
      }
    }
    setSubmitting(true)
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/discharge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dischargeDiagnosis, dischargeDrugs, dischargeDevices, dischargeDiet, dischargeSummaryNotes, typedName, ...(slot ?? {}), ...(followUp ? { followUp } : {}) }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not discharge this patient.')
      return
    }
    const body = await res.json()
    setFollowUpCreated(Boolean(body.followUpAppointmentId))
    setFollowUpPlanned(Boolean(body.followUpOrderId))
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
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Follow-up plan</legend>
              <p className="text-xs text-muted-foreground">Optional — recorded only when a reason is entered.</p>
              <select value={planTiming} onChange={(e) => setPlanTiming(e.target.value === 'date' ? 'date' : 'interval')} aria-label="Plan timing" className="w-full rounded-md border border-border px-3 py-2 text-sm">
                <option value="interval">After</option>
                <option value="date">On date</option>
              </select>
              {planTiming === 'interval' ? (
                <div className="flex gap-2">
                  <input type="number" min={1} value={planValue} onChange={(e) => setPlanValue(e.target.value)} aria-label="Follow-up in" placeholder="e.g. 2" className="w-24 rounded-md border border-border px-3 py-2 text-sm" />
                  <select value={planUnit} onChange={(e) => setPlanUnit(e.target.value as IntervalUnit)} aria-label="Follow-up unit" className="flex-1 rounded-md border border-border px-3 py-2 text-sm">
                    {INTERVAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              ) : (
                <input type="date" value={planDate} onChange={(e) => setPlanDate(e.target.value)} aria-label="Follow-up on date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
              )}
              <input value={planReason} onChange={(e) => setPlanReason(e.target.value)} aria-label="Follow-up reason" placeholder="Reason (shown to the front desk)" maxLength={VISIT_REASON_MAX_LENGTH} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </fieldset>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Optional — book a follow-up slot with the attending provider (IST).</p>
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
            {followUpPlanned && !followUpCreated && <p className="text-muted-foreground">A follow-up plan was recorded for the front desk to book.</p>}
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
