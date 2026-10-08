// Wave I (P1-23): report date ranges. Inclusive IST calendar dates (YYYY-MM-DD),
// at most REPORT_MAX_RANGE_DAYS long. Pure.
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { daysBetweenIso } from '@/lib/rcm/sla'

export const REPORT_MAX_RANGE_DAYS = 366

export interface ReportRange { from: string; to: string }

export function parseReportRange(from: string, to: string): { ok: true; range: ReportRange } | { ok: false; error: string } {
  const ok = (s: string) => isoDateSchema.safeParse(s).success
  if (!ok(from) || !ok(to) || from > to) return { ok: false, error: 'Choose a valid date range' }
  if (daysBetweenIso(from, to) > REPORT_MAX_RANGE_DAYS) return { ok: false, error: `Choose at most ${REPORT_MAX_RANGE_DAYS} days` }
  return { ok: true, range: { from, to } }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Page search params -> a range; an absent or bad range falls back to the IST month to date. */
export function resolveReportRange(sp: Record<string, string | string[] | undefined>, todayIst: string): { range: ReportRange; problem: string | null } {
  const fallback = { from: `${todayIst.slice(0, 8)}01`, to: todayIst }
  const from = one(sp.from)
  const to = one(sp.to)
  if (from === undefined && to === undefined) return { range: fallback, problem: null }
  const parsed = parseReportRange(from ?? '', to ?? '')
  return parsed.ok ? { range: parsed.range, problem: null } : { range: fallback, problem: parsed.error }
}
