// WS12 T5 (spec R9): before an ABHA is linked to a chart, the ABDM profile is
// compared with the chart's name, date of birth and gender, so a wrong-person
// link is a conscious, recorded act. Pure and client-safe.
//
// The `chart`/`abdm` display strings in a comparison reach the browser only in
// the dialog of the staff member who ran the flow: never logs or audit details.

export type IdentityField = 'name' | 'dob' | 'gender'

export interface AbhaIdentityProfile {
  name: string | null
  gender: string | null
  yearOfBirth: number | null
  monthOfBirth: number | null
  dayOfBirth: number | null
}

export interface IdentityComparison {
  fields: { field: IdentityField; result: 'match' | 'mismatch' | 'unavailable'; chart: string | null; abdm: string | null }[]
  mismatch: boolean
  mismatchedFields: IdentityField[]
}

export const IDENTITY_MISMATCH_MESSAGE = 'The ABHA profile does not match this patient. Check the details, or give a reason to link anyway.'

export const IDENTITY_FIELDS: readonly IdentityField[] = ['name', 'dob', 'gender']

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'shri', 'sri', 'kumari', 'km', 'master', 'baby'])

/** Lower-cased name tokens without honorifics or punctuation (apostrophes join, other marks split). */
export function normaliseIndianName(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t !== '' && !HONORIFICS.has(t))
}

/**
 * Tokens compared as sets. An initial (one letter) matches an unmatched full
 * token on the other side that starts with it, but only when at least one
 * full token matches exactly. Anything left unmatched is a mismatch.
 */
function namesMatch(a: string[], b: string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size === 0 || right.size === 0) return false
  const common = [...left].filter((t) => right.has(t))
  for (const t of common) { left.delete(t); right.delete(t) }
  if (left.size === 0 && right.size === 0) return true
  if (!common.some((t) => t.length > 1)) return false
  const pair = (initials: Set<string>, fulls: Set<string>) => {
    for (const i of [...initials]) {
      if (i.length !== 1) continue
      const hit = [...fulls].find((f) => f.length > 1 && f.startsWith(i))
      if (hit) { initials.delete(i); fulls.delete(hit) }
    }
  }
  pair(left, right)
  pair(right, left)
  return left.size === 0 && right.size === 0
}

const pad = (n: number) => String(n).padStart(2, '0')
const GENDER_FROM_ABDM: Record<string, { label: string; chart: readonly string[] }> = {
  M: { label: 'male', chart: ['male'] },
  F: { label: 'female', chart: ['female'] },
  O: { label: 'other', chart: ['other', 'transgender'] },
  T: { label: 'transgender', chart: ['other', 'transgender'] },
}

function compareDob(chartDob: string | null, p: AbhaIdentityProfile | null): IdentityComparison['fields'][number] {
  const year = p?.yearOfBirth ?? null
  const month = year != null ? p?.monthOfBirth ?? null : null
  const day = month != null ? p?.dayOfBirth ?? null : null
  const abdm = year == null ? null : [String(year), month != null ? pad(month) : null, day != null ? pad(day) : null].filter(Boolean).join('-')
  const m = chartDob ? /^(\d{4})-(\d{2})-(\d{2})/.exec(chartDob) : null
  if (year == null || !m) return { field: 'dob', result: 'unavailable', chart: chartDob, abdm }
  const same = Number(m[1]) === year && (month == null || Number(m[2]) === month) && (day == null || Number(m[3]) === day)
  return { field: 'dob', result: same ? 'match' : 'mismatch', chart: chartDob, abdm }
}

function compareGender(chartGender: string | null, p: AbhaIdentityProfile | null): IdentityComparison['fields'][number] {
  const g = p?.gender ? GENDER_FROM_ABDM[p.gender.toUpperCase()] : undefined
  const chart = chartGender && chartGender !== 'unknown' ? chartGender : null
  if (!g || !chart) return { field: 'gender', result: 'unavailable', chart: chartGender, abdm: g?.label ?? null }
  return { field: 'gender', result: g.chart.includes(chart) ? 'match' : 'mismatch', chart: chartGender, abdm: g.label }
}

/** Compares the chart with the ABDM profile. No stored profile counts as a name mismatch. */
export function compareAbhaIdentity(
  chart: { name: string; dob: string | null; gender: string | null },
  profile: AbhaIdentityProfile | null,
): IdentityComparison {
  const name: IdentityComparison['fields'][number] = profile === null
    ? { field: 'name', result: 'mismatch', chart: chart.name, abdm: null }
    : profile.name == null || profile.name.trim() === ''
      ? { field: 'name', result: 'unavailable', chart: chart.name, abdm: null }
      : { field: 'name', result: namesMatch(normaliseIndianName(chart.name), normaliseIndianName(profile.name)) ? 'match' : 'mismatch', chart: chart.name, abdm: profile.name }
  const fields = [name, compareDob(chart.dob, profile), compareGender(chart.gender, profile)]
  const mismatchedFields = fields.filter((f) => f.result === 'mismatch').map((f) => f.field)
  return { fields, mismatch: mismatchedFields.length > 0, mismatchedFields }
}
