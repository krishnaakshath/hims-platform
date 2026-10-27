// WS4 T8 (spec 3.3 items 17, 19, 20): analyte definitions, reference-range choice and the
// automatic flagging rules. Pure and client-safe: no DB, env or node imports, so the result
// entry form computes the same flag the server stores.
import type { LabResultFlag } from '@/lib/labs/report-data'

export type { LabResultFlag }
export type AnalyteValueType = 'numeric' | 'option' | 'text'
export type Interpretation = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' | 'AA'

export interface AnalyteRange {
  sex: 'any' | 'male' | 'female'
  /** Age band in days, [ageMinDays, ageMaxDays); null max = no upper limit. */
  ageMinDays: number
  ageMaxDays: number | null
  normalLow: number | null
  normalHigh: number | null
  criticalLow: number | null
  criticalHigh: number | null
  displayText: string | null
}

export interface AnalyteDef {
  id: number
  code: string
  name: string
  unit: string | null
  valueType: AnalyteValueType
  decimals: number | null
  options: string[] | null
  abnormalOptions: string[] | null
  criticalOptions: string[] | null
  ranges: AnalyteRange[]
}

/** Shown with every seeded test's analytes in the Lab setup editor (spec 3.3 item 21). */
export const DEMO_REFERENCE_RANGE_NOTE = 'Demo reference ranges: the laboratory director must review before clinical use'

const bandWidth = (r: AnalyteRange) => (r.ageMaxDays === null ? Number.POSITIVE_INFINITY : r.ageMaxDays - r.ageMinDays)

/**
 * The range that applies to a patient: among ranges whose age band covers `ageDays`, an exact
 * sex match before `any`, then the narrowest age band. A patient who is not male/female
 * (`sex` null: transgender, other, unknown or not recorded) gets only `any` ranges.
 */
export function selectRange(ranges: AnalyteRange[], sex: 'male' | 'female' | null, ageDays: number): AnalyteRange | null {
  const fits = ranges.filter((r) =>
    (r.sex === 'any' || (sex !== null && r.sex === sex)) && ageDays >= r.ageMinDays && (r.ageMaxDays === null || ageDays < r.ageMaxDays))
  if (fits.length === 0) return null
  return fits.reduce((best, r) => {
    const exactR = r.sex !== 'any'
    const exactBest = best.sex !== 'any'
    if (exactR !== exactBest) return exactR ? r : best
    return bandWidth(r) < bandWidth(best) ? r : best
  })
}

function decimalsOf(n: number): number {
  const s = String(n)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

/** "12.0-15.5 g/dL", "<200", "≥40 mg/dL"; the range's own display text wins; null when nothing to show. */
export function rangeText(r: AnalyteRange | null, unit: string | null): string | null {
  if (!r) return null
  const withUnit = (s: string) => (unit ? `${s} ${unit}` : s)
  if (r.displayText) return r.displayText
  const { normalLow: lo, normalHigh: hi } = r
  if (lo !== null && hi !== null) {
    const d = Math.max(decimalsOf(lo), decimalsOf(hi))
    return withUnit(`${lo.toFixed(d)}-${hi.toFixed(d)}`)
  }
  if (hi !== null) return withUnit(`<${hi}`)
  if (lo !== null) return withUnit(`≥${lo}`)
  return null
}

const NUMBER = /^-?\d+(\.\d+)?$/
const sameOption = (list: string[] | null, v: string) => (list ?? []).some((o) => o.toLowerCase() === v.toLowerCase())

/**
 * The automatic flag for one entered value, or null when there is none (comparator values such
 * as "<0.1", text analytes, unparseable values, no applicable range): the entry form then
 * requires a manual flag. Numeric: outside normal is abnormal (L/H); at or beyond a critical
 * limit is critical (LL/HH) (spec: value <= critical-low or >= critical-high): with a critical-low
 * of 7, 7.0 is LL and 7.01 is L. Values on a normal bound are normal.
 */
export function flagAnalyteValue(def: AnalyteDef, value: string, range: AnalyteRange | null): { flag: LabResultFlag; interpretation: Interpretation } | null {
  const v = value.trim()
  if (v === '') return null
  if (def.valueType === 'text') return null
  if (def.valueType === 'option') {
    if (sameOption(def.criticalOptions, v)) return { flag: 'critical', interpretation: 'AA' }
    if (sameOption(def.abnormalOptions, v)) return { flag: 'abnormal', interpretation: 'A' }
    if (sameOption(def.options, v)) return { flag: 'normal', interpretation: 'N' }
    return null
  }
  if (!NUMBER.test(v) || range === null) return null
  const { normalLow, normalHigh, criticalLow, criticalHigh } = range
  if (normalLow === null && normalHigh === null && criticalLow === null && criticalHigh === null) return null
  const n = Number(v)
  if (criticalLow !== null && n <= criticalLow) return { flag: 'critical', interpretation: 'LL' }
  if (criticalHigh !== null && n >= criticalHigh) return { flag: 'critical', interpretation: 'HH' }
  if (normalLow !== null && n < normalLow) return { flag: 'abnormal', interpretation: 'L' }
  if (normalHigh !== null && n > normalHigh) return { flag: 'abnormal', interpretation: 'H' }
  return { flag: 'normal', interpretation: 'N' }
}

const SEVERITY: Record<LabResultFlag, number> = { normal: 0, abnormal: 1, critical: 2 }

/** The most severe flag (the summary row's flag); normal for none. */
export function worstFlag(flags: LabResultFlag[]): LabResultFlag {
  return flags.reduce<LabResultFlag>((w, f) => (SEVERITY[f] > SEVERITY[w] ? f : w), 'normal')
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** Whole calendar days from a date of birth to a date (both read as YYYY-MM-DD; never negative). */
export function ageInDays(dobIso: string, onIso: string): number {
  return Math.max(0, Math.round(dayNumber(onIso) - dayNumber(dobIso)))
}
