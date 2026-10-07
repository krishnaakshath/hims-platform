export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

/** Calendar date (YYYY-MM-DD) in the given timezone. */
export function todayIsoIn(tz: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Age in whole years on a given ISO date. */
export function ageOnDate(dobIso: string, onIso: string): number {
  const [by, bm, bd] = dobIso.slice(0, 10).split('-').map(Number)
  const [oy, om, od] = onIso.slice(0, 10).split('-').map(Number)
  let age = oy - by
  if (om < bm || (om === bm && od < bd)) age -= 1
  return age
}

// SP3 helpers. Business days are Asia/Kolkata; never use local-time getters.

/** Calendar date (YYYY-MM-DD) in IST of an instant. */
export function istDateOf(instant: Date): string {
  return todayIsoIn(DEFAULT_TIMEZONE, instant)
}

/** The instant at which an IST calendar day starts. */
export function startOfIstDay(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00+05:30`)
}

/** The IST business day containing `now`, as a half-open instant range [start, end). IST has no DST. */
export function istDayBounds(now: Date = new Date()): { start: Date; end: Date } {
  const start = startOfIstDay(todayIsoIn(DEFAULT_TIMEZONE, now))
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) }
}

/** "21 Oct 2026" for a YYYY-MM-DD calendar date (no zone shift). */
export function formatIsoDate(dateIso: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${dateIso}T00:00:00Z`))
}

/** "22 Oct 2026, 12:30 am" in the given zone (default IST). */
export function formatDateTimeIn(instant: Date, tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(instant)
}

// ---------------------------------------------------------------------------
// Wave A: the one time module for display and for parsing input.
//
// Business time is Asia/Kolkata = UTC+05:30 with no DST, so every formatter
// below is pure arithmetic on the UTC instant (no Intl, no toLocale*, no
// dependence on the server's or the browser's zone or ICU data). Server
// components and client components produce the identical string, so a date
// rendered on both sides can never cause a hydration mismatch.
// ---------------------------------------------------------------------------

export const IST_OFFSET = '+05:30'
export const IST_LABEL = 'IST'
const IST_OFFSET_MS = 330 * 60_000
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DASH = '—'

/** Anything a loader may hand a renderer: a Date, an ISO string (e.g. a cached Date), epoch ms, or nothing. */
export type InstantInput = Date | string | number | null | undefined

function toInstant(value: InstantInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function istParts(d: Date) {
  const s = new Date(d.getTime() + IST_OFFSET_MS)
  return { y: s.getUTCFullYear(), mo: s.getUTCMonth(), day: s.getUTCDate(), wd: s.getUTCDay(), h: s.getUTCHours(), mi: s.getUTCMinutes() }
}

function clock(h: number, mi: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

type LabelOpt = { label?: boolean }

/** "8 Oct 2026" -- the IST calendar date of an instant. */
export function formatIstDate(value: InstantInput): string {
  const d = toInstant(value)
  if (!d) return DASH
  const p = istParts(d)
  return `${p.day} ${MONTHS_SHORT[p.mo]} ${p.y}`
}

/** "9:00 am" (or "9:00 am IST" with { label: true}). */
export function formatIstTime(value: InstantInput, opts: LabelOpt = {}): string {
  const d = toInstant(value)
  if (!d) return DASH
  const p = istParts(d)
  return `${clock(p.h, p.mi)}${opts.label ? ` ${IST_LABEL}` : ''}`
}

/** "8 Oct 2026, 9:00 am" (or "... IST" with { label: true }). */
export function formatIstDateTime(value: InstantInput, opts: LabelOpt = {}): string {
  const d = toInstant(value)
  if (!d) return DASH
  return `${formatIstDate(d)}, ${formatIstTime(d, opts)}`
}

/** "Thursday, 8 October 2026" -- for patient-facing messages. */
export function formatIstLongDate(value: InstantInput): string {
  const d = toInstant(value)
  if (!d) return DASH
  const p = istParts(d)
  return `${WEEKDAYS_LONG[p.wd]}, ${p.day} ${MONTHS_LONG[p.mo]} ${p.y}`
}

/** "October 2026". */
export function formatIstMonthYear(value: InstantInput): string {
  const d = toInstant(value)
  if (!d) return DASH
  const p = istParts(d)
  return `${MONTHS_LONG[p.mo]} ${p.y}`
}

/** "Thu 8" -- calendar column headings. */
export function formatIstWeekdayDay(value: InstantInput): string {
  const d = toInstant(value)
  if (!d) return DASH
  const p = istParts(d)
  return `${WEEKDAYS_SHORT[p.wd]} ${p.day}`
}

/** "8 Oct" -- compact activity feeds. */
export function formatIstDayMonth(value: InstantInput): string {
  const d = toInstant(value)
  if (!d) return DASH
  const p = istParts(d)
  return `${p.day} ${MONTHS_SHORT[p.mo]}`
}

/** "2026-10-08" -> "8 Oct 2026" for a calendar date with no time (no zone shift). '—' when empty/invalid. */
export function formatCalendarDate(dateIso: string | null | undefined): string {
  if (!dateIso) return DASH
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso)
  if (!m) return DASH
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1] ?? DASH} ${m[1]}`
}

/** An IST wall-clock slot as an explicit-offset string: ("2026-10-08", "09:00") -> "2026-10-08T09:00:00+05:30". */
export function istSlotString(dateIso: string, hhmm: string): string {
  return `${dateIso}T${hhmm}:00${IST_OFFSET}`
}

const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * A `datetime-local` value (or date + "T" + time, no zone) read as IST wall-clock time,
 * as an explicit-offset string the server accepts: "2026-10-08T09:00" -> "2026-10-08T09:00:00+05:30".
 * null if the value is malformed, carries its own zone, or names an impossible date/time.
 */
export function istLocalToOffsetString(local: string): string | null {
  const m = LOCAL_DT.exec(local)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return null
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) return null
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${IST_OFFSET}`
}

/** The instant an IST `datetime-local` value denotes, or null if invalid. */
export function parseIstLocalDateTime(local: string): Date | null {
  const s = istLocalToOffsetString(local)
  return s ? new Date(s) : null
}

/** True when an ISO date-time string carries an explicit UTC offset (Z or ±HH:MM). */
export function hasExplicitUtcOffset(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
}
