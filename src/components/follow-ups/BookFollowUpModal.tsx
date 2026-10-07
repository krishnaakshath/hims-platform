'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { FollowUpView } from '@/lib/follow-ups/view'
import { istSlotString } from '@/lib/follow-ups/rules'
import { bookFollowUpSlot } from './api'
import { FIELD, LABEL, formatIsoDate } from './format'

export type BookableFollowUp = Pick<FollowUpView, 'id' | 'dueDate' | 'windowStart' | 'windowEnd' | 'prescribedBy' | 'appointment'>

const DURATIONS = [10, 15, 20, 30] as const

function addMinutes(hhmm: string, minutes: number): { hhmm: string; nextDay: boolean } {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + minutes
  return { hhmm: `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`, nextDay: total >= 24 * 60 }
}

function nextDayIso(dateIso: string): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

/** Book (or reschedule) a follow-up's appointment. Times are sent as IST with an explicit +05:30 offset. */
export function BookFollowUpModal({
  followUp, providers, todayIso, onClose,
}: {
  followUp: BookableFollowUp
  providers: { id: number; name: string }[]
  todayIso: string
  onClose: () => void
}) {
  const router = useRouter()
  const uid = useId()
  const rescheduling = followUp.appointment?.status === 'scheduled'
  const [providerId, setProviderId] = useState(String(rescheduling ? followUp.appointment!.providerId : followUp.prescribedBy.providerId))
  const [date, setDate] = useState(followUp.dueDate > todayIso ? followUp.dueDate : todayIso)
  const [time, setTime] = useState('09:00')
  const [duration, setDuration] = useState(15)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const outsideWindow = !!date && (date < followUp.windowStart || date > followUp.windowEnd)
  const id = (k: string) => `${uid}-${k}`

  async function submit() {
    setError(null)
    if (!providerId) { setError('Choose a doctor.'); return }
    if (!date || !time) { setError('Choose a date and time.'); return }
    if (date < todayIso) { setError('The appointment cannot be in the past.'); return }
    const end = addMinutes(time, duration)
    setBusy(true)
    const res = await bookFollowUpSlot(followUp.id, {
      providerId: Number(providerId),
      startsAt: istSlotString(date, time),
      endsAt: istSlotString(end.nextDay ? nextDayIso(date) : date, end.hhmm),
    })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    router.refresh()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader><DialogTitle>{rescheduling ? 'Reschedule follow-up' : 'Book follow-up'}</DialogTitle></DialogHeader>
        <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <p className="text-xs text-muted-foreground">
            Due {formatIsoDate(followUp.dueDate)} (window {formatIsoDate(followUp.windowStart)} to {formatIsoDate(followUp.windowEnd)}). Times are India time (IST).
          </p>
          <div>
            <label htmlFor={id('doctor')} className={LABEL}>Doctor</label>
            <select id={id('doctor')} value={providerId} onChange={(e) => setProviderId(e.target.value)} className={FIELD}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('date')} className={LABEL}>Date</label>
              <input id={id('date')} type="date" value={date} min={todayIso} onChange={(e) => setDate(e.target.value)} className={FIELD} required />
            </div>
            <div>
              <label htmlFor={id('time')} className={LABEL}>Time</label>
              <input id={id('time')} type="time" value={time} onChange={(e) => setTime(e.target.value)} className={FIELD} required />
            </div>
          </div>
          <div>
            <label htmlFor={id('dur')} className={LABEL}>Duration</label>
            <select id={id('dur')} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={FIELD}>
              {DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">Minutes.</p>
          </div>
          {outsideWindow && (
            <p role="alert" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              This date is outside the follow-up window ({formatIsoDate(followUp.windowStart)} to {formatIsoDate(followUp.windowEnd)}). You can still book it.
            </p>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : rescheduling ? 'Reschedule appointment' : 'Book appointment'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
