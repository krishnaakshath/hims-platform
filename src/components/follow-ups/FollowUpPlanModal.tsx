'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { FollowUpView } from '@/lib/follow-ups/view'
import type { EncounterListRow } from '@/lib/queries/encounters'
import { INTERVAL_UNITS, DEFAULT_WINDOW_DAYS_AFTER, DEFAULT_WINDOW_DAYS_BEFORE, dueDateProblem, type IntervalUnit } from '@/lib/follow-ups/rules'
import { followUpReasonSchema } from '@/lib/follow-ups/validation'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import type { CreateFollowUpRequest, UpdateFollowUpPlanRequest } from '@/lib/follow-ups/validation'
import { createFollowUp, updateFollowUp } from './api'
import { FIELD, LABEL, daysBetweenIso, formatIsoDate } from './format'

type Timing = { kind: 'interval'; value: number; unit: IntervalUnit } | { kind: 'date'; dueDate: string }

function toTimingBody(t: Timing) {
  return t.kind === 'interval' ? { kind: 'interval' as const, interval: { value: t.value, unit: t.unit } } : { kind: 'date' as const, dueDate: t.dueDate }
}

/** Set (create) or change (edit) a follow-up plan. pi prescribes as themself (no prescriber select); admin names the prescriber. */
export function FollowUpPlanModal({
  mode, patientId, initial, providers, departments, encounters, isPi, todayIso, onClose,
}: {
  mode: 'create' | 'edit'
  patientId: string
  initial?: FollowUpView
  providers: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  encounters: EncounterListRow[]
  isPi: boolean
  todayIso: string
  onClose: () => void
}) {
  const router = useRouter()
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`

  const initTiming: Timing = initial
    ? initial.interval ? { kind: 'interval', value: initial.interval.value, unit: initial.interval.unit } : { kind: 'date', dueDate: initial.dueDate }
    : { kind: 'interval', value: 2, unit: 'weeks' }
  const initBefore = initial ? daysBetweenIso(initial.windowStart, initial.dueDate) : DEFAULT_WINDOW_DAYS_BEFORE
  const initAfter = initial ? daysBetweenIso(initial.dueDate, initial.windowEnd) : DEFAULT_WINDOW_DAYS_AFTER

  const [timingKind, setTimingKind] = useState<'interval' | 'date'>(initTiming.kind)
  const [value, setValue] = useState(String(initTiming.kind === 'interval' ? initTiming.value : 2))
  const [unit, setUnit] = useState<IntervalUnit>(initTiming.kind === 'interval' ? initTiming.unit : 'weeks')
  const [dueDate, setDueDate] = useState(initTiming.kind === 'date' ? initTiming.dueDate : '')
  const [before, setBefore] = useState(String(initBefore))
  const [after, setAfter] = useState(String(initAfter))
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [planNotes, setPlanNotes] = useState(initial?.planNotes ?? '')
  const [prescriber, setPrescriber] = useState(String(initial?.prescribedBy.providerId ?? ''))
  const [departmentId, setDepartmentId] = useState(String(initial?.department?.id ?? ''))
  const [encounterId, setEncounterId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [outsideNotice, setOutsideNotice] = useState(false)
  const [busy, setBusy] = useState(false)

  function currentTiming(): Timing | string {
    if (timingKind === 'interval') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > 365) return 'Enter a whole number from 1 to 365.'
      return { kind: 'interval', value: n, unit }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return 'Choose a date.'
    return { kind: 'date', dueDate }
  }

  async function submit() {
    setServerError(null)
    const errs: Record<string, string> = {}
    const timing = currentTiming()
    if (typeof timing === 'string') errs.timing = timing
    const b = Number(before), a = Number(after)
    if (!Number.isInteger(b) || b < 0 || b > 30) errs.before = 'Whole days, 0 to 30.'
    if (!Number.isInteger(a) || a < 0 || a > 60) errs.after = 'Whole days, 0 to 60.'
    const reasonParsed = followUpReasonSchema.safeParse(reason)
    if (!reasonParsed.success) errs.reason = reason.trim() ? `At most ${VISIT_REASON_MAX_LENGTH} characters.` : 'Enter a short reason for the visit.'
    if (planNotes.length > 2000) errs.planNotes = 'At most 2000 characters.'
    if (!isPi && mode === 'create' && !prescriber) errs.prescriber = 'Choose the prescribing doctor.'
    if (mode === 'create' || (typeof timing !== 'string' && JSON.stringify(timing) !== JSON.stringify(initTiming))) {
      if (typeof timing !== 'string' && timing.kind === 'date') {
        const problem = dueDateProblem(timing.dueDate, todayIso)
        if (problem) errs.timing = problem
      }
    }
    if (Object.keys(errs).length > 0) { setErrors(errs); return }
    setErrors({})
    const t = timing as Timing

    setBusy(true)
    if (mode === 'create') {
      const body: CreateFollowUpRequest = {
        patientId,
        timing: toTimingBody(t),
        windowDaysBefore: b,
        windowDaysAfter: a,
        reason: reasonParsed.data!,
        ...(planNotes.trim() ? { planNotes: planNotes.trim() } : {}),
        ...(!isPi && prescriber ? { prescribedByProviderId: Number(prescriber) } : {}),
        ...(departmentId ? { departmentId: Number(departmentId) } : {}),
        ...(encounterId ? { originatingEncounterId: Number(encounterId) } : {}),
      }
      const res = await createFollowUp(body)
      setBusy(false)
      if (!res.ok) { setServerError(res.error); return }
      router.refresh()
      onClose()
      return
    }

    // Edit: send only what changed, so a reason-only edit never re-resolves dates.
    const patch: UpdateFollowUpPlanRequest = {}
    if (JSON.stringify(t) !== JSON.stringify(initTiming)) patch.timing = toTimingBody(t)
    if (b !== initBefore) patch.windowDaysBefore = b
    if (a !== initAfter) patch.windowDaysAfter = a
    if (reasonParsed.data !== initial!.reason) patch.reason = reasonParsed.data
    if (planNotes.trim() !== (initial!.planNotes ?? '')) patch.planNotes = planNotes.trim() ? planNotes.trim() : null
    if (!isPi && prescriber && Number(prescriber) !== initial!.prescribedBy.providerId) patch.prescribedByProviderId = Number(prescriber)
    if (departmentId !== String(initial!.department?.id ?? '')) patch.departmentId = departmentId ? Number(departmentId) : null
    if (Object.keys(patch).length === 0) { setBusy(false); onClose(); return }
    const res = await updateFollowUp(initial!.id, patch)
    setBusy(false)
    if (!res.ok) { setServerError(res.error); return }
    router.refresh()
    if (res.data.bookingOutsideWindow) { setOutsideNotice(true); return }
    onClose()
  }

  const err = (k: string) => errors[k] && <p className="mt-1 text-xs text-destructive">{errors[k]}</p>

  if (outsideNotice) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Plan saved</DialogTitle></DialogHeader>
          <p role="status" className="text-sm text-foreground">
            The existing booking now falls outside the new follow-up window. It has not been moved; ask the front desk to reschedule if needed.
          </p>
          <DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{mode === 'create' ? 'Set follow-up' : 'Change follow-up plan'}</DialogTitle></DialogHeader>
        <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <fieldset className="space-y-2">
            <legend className={LABEL}>When should the patient return?</legend>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name={id('kind')} checked={timingKind === 'interval'} onChange={() => setTimingKind('interval')} />
                In
              </label>
              <input aria-label="Number" type="number" min={1} max={365} value={value} onChange={(e) => setValue(e.target.value)} disabled={timingKind !== 'interval'} className={`${FIELD} !w-20`} />
              <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as IntervalUnit)} disabled={timingKind !== 'interval'} className={`${FIELD} !w-28`}>
                {INTERVAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name={id('kind')} checked={timingKind === 'date'} onChange={() => setTimingKind('date')} />
                On date
              </label>
              <input aria-label="Follow-up date" type="date" min={todayIso} value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={timingKind !== 'date'} className={`${FIELD} !w-44`} />
            </div>
            {initial && <p className="text-xs text-muted-foreground">Currently due {formatIsoDate(initial.dueDate)}.</p>}
            {err('timing')}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('before')} className={LABEL}>Window: days before</label>
              <input id={id('before')} type="number" min={0} max={30} value={before} onChange={(e) => setBefore(e.target.value)} className={FIELD} />
              {err('before')}
            </div>
            <div>
              <label htmlFor={id('after')} className={LABEL}>Window: days after</label>
              <input id={id('after')} type="number" min={0} max={60} value={after} onChange={(e) => setAfter(e.target.value)} className={FIELD} />
              {err('after')}
            </div>
          </div>
          <div>
            <label htmlFor={id('reason')} className={LABEL}>Reason (shown to front desk and patient reminders)</label>
            <input id={id('reason')} value={reason} maxLength={VISIT_REASON_MAX_LENGTH} onChange={(e) => setReason(e.target.value)} className={FIELD} required />
            {err('reason')}
          </div>
          <div>
            <label htmlFor={id('notes')} className={LABEL}>Clinical plan notes (doctors and admin only)</label>
            <textarea id={id('notes')} value={planNotes} maxLength={2000} rows={3} onChange={(e) => setPlanNotes(e.target.value)} className={FIELD} />
            {err('planNotes')}
          </div>
          {!isPi && (
            <div>
              <label htmlFor={id('presc')} className={LABEL}>Prescribing doctor</label>
              <select id={id('presc')} value={prescriber} onChange={(e) => setPrescriber(e.target.value)} className={FIELD}>
                <option value="">Select doctor</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {err('prescriber')}
            </div>
          )}
          <div>
            <label htmlFor={id('dept')} className={LABEL}>Department</label>
            <select id={id('dept')} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={FIELD}>
              <option value="">Doctor&apos;s department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          {mode === 'create' && encounters.length > 0 && (
            <div>
              <label htmlFor={id('enc')} className={LABEL}>From visit (optional)</label>
              <select id={id('enc')} value={encounterId} onChange={(e) => setEncounterId(e.target.value)} className={FIELD}>
                <option value="">Not linked to a visit</option>
                {encounters.map((e) => <option key={e.id} value={e.id}>{formatIsoDate(e.encounterDate)}, {e.providerName}</option>)}
              </select>
            </div>
          )}
          {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : mode === 'create' ? 'Save follow-up' : 'Save changes'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
