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
