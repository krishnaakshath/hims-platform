// WS6 T6 (spec D5): a doctor's bookable slots are computed on read from the weekly template
// (provider_schedules), the slot length (providers.slot_minutes) and leave days
// (provider_leave); they are never stored. Sessions are IST wall-clock times; IST has no DST,
// so a wall-clock minute is the IST day start plus that many minutes.
import { istDateOf, startOfIstDay } from '@/lib/india-time'

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** One working session of a weekly template: weekday 0 = Sunday, times HH:MM in IST. */
export interface WeeklySession {
  weekday: Weekday
  start: string
  end: string
}

export type SlotStatus = 'free' | 'booked' | 'past'

export interface Slot {
  startsAt: Date
  endsAt: Date
  status: SlotStatus
}

const MINUTE_MS = 60_000

/** Minutes since midnight of an HH:MM time. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD calendar date, independent of the server zone. */
export function istWeekdayOf(dateIso: string): Weekday {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() as Weekday
}

function sessionsOn(dateIso: string, sessions: WeeklySession[]): WeeklySession[] {
  const weekday = istWeekdayOf(dateIso)
  return sessions.filter((s) => s.weekday === weekday).sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
}

/**
 * The slots of one IST day. A leave day has none. A trailing piece of a session shorter than
 * the slot length is not offered. A slot that started before `now` is 'past' (even if booked);
 * otherwise one overlapping any booking is 'booked'.
 */
export function buildSlots(i: {
  dateIso: string
  sessions: WeeklySession[]
  slotMinutes: number
  onLeave: boolean
  booked: { startsAt: Date; endsAt: Date }[]
  now: Date
}): Slot[] {
  if (i.onLeave || i.slotMinutes <= 0) return []
  const dayStart = startOfIstDay(i.dateIso).getTime()
  const out: Slot[] = []
  for (const s of sessionsOn(i.dateIso, i.sessions)) {
    const end = minutesOf(s.end)
    for (let t = minutesOf(s.start); t + i.slotMinutes <= end; t += i.slotMinutes) {
      const startsAt = new Date(dayStart + t * MINUTE_MS)
      const endsAt = new Date(dayStart + (t + i.slotMinutes) * MINUTE_MS)
      const status: SlotStatus = startsAt.getTime() < i.now.getTime()
        ? 'past'
        : i.booked.some((b) => b.startsAt.getTime() < endsAt.getTime() && b.endsAt.getTime() > startsAt.getTime()) ? 'booked' : 'free'
      out.push({ startsAt, endsAt, status })
    }
  }
  return out
}

/** True when [startsAt, endsAt) lies wholly inside one session of its IST weekday and the doctor is not on leave. */
export function withinWorkingHours(i: { startsAt: Date; endsAt: Date; sessions: WeeklySession[]; onLeave: boolean }): boolean {
  if (i.onLeave) return false
  const dateIso = istDateOf(i.startsAt)
  const dayStart = startOfIstDay(dateIso).getTime()
  const from = (i.startsAt.getTime() - dayStart) / MINUTE_MS
  const to = (i.endsAt.getTime() - dayStart) / MINUTE_MS
  return sessionsOn(dateIso, i.sessions).some((s) => minutesOf(s.start) <= from && to <= minutesOf(s.end))
}
