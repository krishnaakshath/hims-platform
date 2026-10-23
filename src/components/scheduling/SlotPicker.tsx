'use client'
import { useEffect, useRef, useState } from 'react'
import { istSlotString } from '@/lib/india-time'

// WS6 T7 (spec D5): pick a doctor's appointment time from their computed slots
// (GET /api/providers/[id]/slots). "Other time" takes a typed IST start and end; a typed time
// outside the doctor's working hours (or on a leave day) is only passed up once the
// "Outside working hours" box is ticked, and then carries outsideHours: true so the form sends
// outsideHoursConfirmed. A doctor with no working hours set up (or slots that fail to load)
// gets the time inputs directly. onChange(null) means "no usable time yet"; a new doctor or date
// clears the value.

export interface SlotValue {
  startsAt: string
  endsAt: string
  outsideHours: boolean
}

interface ApiSlot {
  startsAt: string
  endsAt: string
  status: 'free' | 'booked' | 'past'
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; slots: ApiSlot[]; onLeave: boolean; hoursSet: boolean }
  | { state: 'failed' }

const IST_OFFSET_MS = 330 * 60_000
const STATUS_LABEL: Record<ApiSlot['status'], string> = { free: 'free', booked: 'booked', past: 'past' }

/** HH:MM IST of an instant. */
function istClock(iso: string): string {
  return new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(11, 16)
}

function readDay(data: unknown): { slots: ApiSlot[]; onLeave: boolean; hoursSet: boolean } {
  const d = (data && typeof data === 'object' ? data : {}) as { slots?: unknown; onLeave?: unknown; hoursSet?: unknown }
  const slots = Array.isArray(d.slots) ? (d.slots as ApiSlot[]) : []
  const onLeave = d.onLeave === true
  return { slots, onLeave, hoursSet: typeof d.hoursSet === 'boolean' ? d.hoursSet : slots.length > 0 || onLeave }
}

/** The slot list merged into contiguous working intervals (epoch ms). */
function workingIntervals(slots: ApiSlot[]): [number, number][] {
  const sorted = slots.map((s) => [Date.parse(s.startsAt), Date.parse(s.endsAt)] as [number, number]).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [from, to] of sorted) {
    const last = out.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}

interface Custom { start: string; end: string; confirmed: boolean }

/** No working hours set up (or no answer): any typed time is fine, as on the server. */
const hasNoHours = (l: Load) => l.state === 'failed' || (l.state === 'ready' && !l.hoursSet)
/** Whether the typed time is shown without "Other time": nothing to pick on this day. */
const typedOnly = (l: Load, allowCustom: boolean) => hasNoHours(l) || (allowCustom && l.state === 'ready' && l.slots.length === 0)

/** The typed IST time on `date` and whether it falls outside the hours `l` shows. */
function typedTime(l: Load, date: string, c: Custom): { startsAt: string; endsAt: string; valid: boolean; outside: boolean } {
  const startsAt = date && c.start ? istSlotString(date, c.start) : ''
  const endsAt = date && c.end ? istSlotString(date, c.end) : ''
  const valid = Boolean(startsAt && endsAt) && Date.parse(endsAt) > Date.parse(startsAt)
  const outside = valid && l.state === 'ready' && !hasNoHours(l) && (l.onLeave
    || !workingIntervals(l.slots).some(([from, to]) => from <= Date.parse(startsAt) && Date.parse(endsAt) <= to))
  return { startsAt, endsAt, valid, outside }
}

/** What a typed time hands the form: nothing until it is valid and, if outside hours, confirmed. */
function typedValue(l: Load, date: string, c: Custom): SlotValue | null {
  const t = typedTime(l, date, c)
  if (!t.valid || (t.outside && !c.confirmed)) return null
  return { startsAt: t.startsAt, endsAt: t.endsAt, outsideHours: t.outside }
}

export function SlotPicker({ providerId, date, value, onChange, allowCustom }: {
  providerId: number
  date: string
  value: { startsAt: string; endsAt: string } | null
  onChange(v: SlotValue | null): void
  allowCustom: boolean
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [otherTime, setOtherTime] = useState(false)
  const [custom, setCustomState] = useState<Custom>({ start: '09:00', end: '09:30', confirmed: false })
  // The fetch callback reads the typed time and calls the parent's latest callback.
  const customRef = useRef(custom)
  const onChangeRef = useRef(onChange)
  const allowCustomRef = useRef(allowCustom)
  useEffect(() => { onChangeRef.current = onChange; allowCustomRef.current = allowCustom })

  // Values are handed up from event handlers (not an effect), so the form's Save state changes
  // in the same render that shows the time.
  function setCustom(patch: Partial<Custom>) {
    const next = { ...customRef.current, ...patch }
    customRef.current = next
    setCustomState(next)
    onChange(typedValue(load, date, next))
  }

  useEffect(() => {
    let live = true
    const reset = { ...customRef.current, confirmed: false }
    customRef.current = reset
    setCustomState(reset)
    setLoad({ state: 'loading' })
    setOtherTime(false)
    onChangeRef.current(null)
    const settle = (l: Load) => {
      if (!live) return
      setLoad(l)
      // Nothing to pick from: the typed time is shown straight away and is the value.
      if (typedOnly(l, allowCustomRef.current)) onChangeRef.current(typedValue(l, date, customRef.current))
    }
    fetch(`/api/providers/${providerId}/slots?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('slots')
        settle({ state: 'ready', ...readDay(await res.json().catch(() => null)) })
      })
      .catch(() => settle({ state: 'failed' }))
    return () => { live = false }
  }, [providerId, date])

  const ready = load.state === 'ready' ? load : null
  const showCustom = typedOnly(load, allowCustom) || (allowCustom && otherTime)
  const { outside } = typedTime(load, date, custom)

  const chosen = value ? Date.parse(value.startsAt) : null

  return (
    <div className="space-y-2" aria-label="Appointment time" role="group">
      {load.state === 'loading' && <p className="text-xs text-muted-foreground">Loading the doctor&apos;s slots…</p>}
      {load.state === 'failed' && <p className="text-xs text-muted-foreground">The doctor&apos;s slots could not be loaded. Enter the time.</p>}
      {ready && !ready.hoursSet && <p className="text-xs text-muted-foreground">No working hours are set up for this doctor. Enter the time.</p>}
      {ready && ready.hoursSet && ready.onLeave && <p className="text-xs text-muted-foreground">The doctor is on leave on this date.</p>}
      {ready && ready.hoursSet && !ready.onLeave && ready.slots.length === 0 && (
        <p className="text-xs text-muted-foreground">The doctor has no working hours on this day.</p>
      )}
      {ready && ready.slots.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ready.slots.map((s) => {
            const pressed = !showCustom && chosen === Date.parse(s.startsAt)
            const label = istClock(s.startsAt)
            return (
              <button
                key={s.startsAt}
                type="button"
                disabled={s.status !== 'free'}
                aria-pressed={pressed}
                aria-label={s.status === 'free' ? label : `${label} ${STATUS_LABEL[s.status]}`}
                onClick={() => { setOtherTime(false); onChange({ startsAt: s.startsAt, endsAt: s.endsAt, outsideHours: false }) }}
                className={`rounded-md border px-2.5 py-1 text-xs tabular-nums ${pressed
                  ? 'border-primary bg-primary text-primary-foreground'
                  : s.status === 'free' ? 'border-border hover:bg-muted' : 'cursor-not-allowed border-border text-muted-foreground line-through opacity-60'}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
      {ready && ready.slots.length > 0 && allowCustom && !otherTime && (
        <button type="button" onClick={() => { setOtherTime(true); onChange(typedValue(load, date, customRef.current)) }} className="text-xs font-medium text-primary underline-offset-2 hover:underline">Other time</button>
      )}
      {showCustom && (
        <>
          <div className="flex gap-2">
            <input value={custom.start} onChange={(e) => setCustom({ start: e.target.value })} type="time" aria-label="Start time (IST)" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            <input value={custom.end} onChange={(e) => setCustom({ end: e.target.value })} type="time" aria-label="End time (IST)" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          {outside && (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={custom.confirmed} onChange={(e) => setCustom({ confirmed: e.target.checked })} />
              Outside working hours: book this time anyway
            </label>
          )}
        </>
      )}
    </div>
  )
}
