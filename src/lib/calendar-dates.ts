// Calendar arithmetic on Asia/Kolkata days (Wave A). A "day" Date is the
// instant its IST day starts (00:00 IST = 18:30Z the previous UTC day). IST is
// a fixed UTC+05:30 with no DST, so everything here is pure arithmetic on the
// UTC instant -- the server's (UTC on Vercel) or browser's zone never matters.
import { istDateOf, startOfIstDay, todayIsoIn } from '@/lib/india-time'

export type CalendarView = 'day' | 'week' | 'month'

const DAY_MS = 24 * 60 * 60 * 1000
const IST_OFFSET_MS = 330 * 60_000

/** IST wall-clock components of an instant (month 0-indexed, weekday 0 = Sunday). */
function istFields(date: Date): { y: number; m: number; d: number; wd: number } {
  const s = new Date(date.getTime() + IST_OFFSET_MS)
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), wd: s.getUTCDay() }
}

function istDayStart(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - IST_OFFSET_MS)
}

export function startOfDay(date: Date): Date {
  const f = istFields(date)
  return istDayStart(f.y, f.m, f.d)
}

export function endOfDay(date: Date): Date {
  return new Date(startOfDay(date).getTime() + DAY_MS - 1)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

/** The first IST day of the month `months` away from date's IST month. */
export function addMonths(date: Date, months: number): Date {
  const f = istFields(date)
  return istDayStart(f.y, f.m + months, 1)
}

// Sunday-start week, matching the standard Day/Week/Month calendar convention.
export function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -istFields(date).wd)
}

export function startOfMonth(date: Date): Date {
  return addMonths(date, 0)
}

export function isSameDay(a: Date, b: Date): boolean {
  return istDateOf(a) === istDateOf(b)
}

/** IST day of month (1-31). */
export function istDayOfMonth(date: Date): number {
  return istFields(date).d
}

/** IST month (0-11). */
export function istMonthIndex(date: Date): number {
  return istFields(date).m
}

/** "YYYY-MM-DD" -> the instant that IST day starts; invalid/missing -> today (IST). */
export function parseDateParam(param: string | undefined): Date {
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const parsed = startOfIstDay(param)
    if (!isNaN(parsed.getTime()) && formatDateParam(parsed) === param) return parsed
  }
  return startOfIstDay(todayIsoIn())
}

export function formatDateParam(date: Date): string {
  const f = istFields(date)
  return `${f.y}-${String(f.m + 1).padStart(2, '0')}-${String(f.d).padStart(2, '0')}`
}

export function getWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

// A fixed 6-week (42-day) grid, matching the standard month-calendar layout —
// includes the leading/trailing days from adjacent months so those days'
// appointments (if any) still render, grayed out, at the grid's edges.
export function getMonthGridDays(anchor: Date): Date[] {
  const gridStart = startOfWeek(startOfMonth(anchor))
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

export function getViewRange(view: CalendarView, anchor: Date): { start: Date; end: Date } {
  if (view === 'day') return { start: startOfDay(anchor), end: endOfDay(anchor) }
  if (view === 'week') {
    const start = startOfWeek(anchor)
    return { start, end: endOfDay(addDays(start, 6)) }
  }
  const gridStart = startOfWeek(startOfMonth(anchor))
  return { start: gridStart, end: endOfDay(addDays(gridStart, 41)) }
}
