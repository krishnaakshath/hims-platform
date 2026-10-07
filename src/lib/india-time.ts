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
