// Wave F P1-04: the OPD register (encounter list) -- filter parsing, labels
// and the CSV export. Pure: no DB, no clock (the caller passes today's IST
// date). The register is non-clinical: token, patient name/UHID/age/sex,
// department, doctor, status and times. It never carries a phone number,
// an address, ABHA or any national ID, on screen or in the CSV.
import { formatIsoDate, formatIstDateTime } from '@/lib/india-time'
import { GENDERS } from '@/lib/india/reference'
import { daysBetweenIso } from '@/lib/follow-ups/rules'
import { parseId } from '@/lib/http'
import {
  ENCOUNTER_STATUSES, ENCOUNTER_TYPES,
  type EncounterStatus, type EncounterType, type EncounterVisitType,
} from '@/lib/encounters/status'

/** The widest date range one register view (or export) may cover, inclusive. */
export const REGISTER_MAX_SPAN_DAYS = 92
/** Rows per view/export; a wider result is reported as truncated. */
export const REGISTER_ROW_LIMIT = 2000

export interface RegisterFilters {
  from: string
  to: string
  /** null = every encounter type. Defaults to 'opd' (it is the OPD register). */
  type: EncounterType | null
  status: EncounterStatus | null
  departmentId: number | null
  providerId: number | null
}

export type RegisterFilterField = 'date' | 'range' | 'type' | 'status' | 'department' | 'doctor'
export type ParseRegisterFiltersResult = { ok: true; filters: RegisterFilters } | { ok: false; field: RegisterFilterField; error: string }

export interface EncounterRegisterRow {
  id: number
  encounterDate: string
  opdToken: number | null
  encounterType: EncounterType
  visitType: EncounterVisitType
  status: EncounterStatus
  checkedInAt: Date
  completedAt: Date | null
  patientId: string
  patientName: string
  uhid: string | null
  ageYears: number
  gender: string | null
  departmentName: string | null
  doctorName: string
}

type RawParams = Record<string, string | string[] | undefined>

function first(sp: RawParams, key: string): string {
  const v = sp[key]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.trim() : ''
}

function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function parseRegisterFilters(sp: RawParams, todayIso: string): ParseRegisterFiltersResult {
  const from = first(sp, 'from') || todayIso
  const to = first(sp, 'to') || todayIso
  if (!isCalendarDate(from) || !isCalendarDate(to)) return { ok: false, field: 'date', error: 'Dates must be valid YYYY-MM-DD dates.' }
  if (from > to) return { ok: false, field: 'range', error: 'The "from" date is after the "to" date.' }
  if (daysBetweenIso(from, to) + 1 > REGISTER_MAX_SPAN_DAYS) return { ok: false, field: 'range', error: `Choose a range of at most ${REGISTER_MAX_SPAN_DAYS} days.` }

  const rawType = first(sp, 'type') || 'opd'
  let type: EncounterType | null
  if (rawType === 'all') type = null
  else if ((ENCOUNTER_TYPES as readonly string[]).includes(rawType)) type = rawType as EncounterType
  else return { ok: false, field: 'type', error: 'Unknown encounter type.' }

  const rawStatus = first(sp, 'status')
  let status: EncounterStatus | null = null
  if (rawStatus && rawStatus !== 'all') {
    if (!(ENCOUNTER_STATUSES as readonly string[]).includes(rawStatus)) return { ok: false, field: 'status', error: 'Unknown status.' }
    status = rawStatus as EncounterStatus
  }

  const rawDept = first(sp, 'department')
  const departmentId = rawDept ? parseId(rawDept) : null
  if (rawDept && departmentId === null) return { ok: false, field: 'department', error: 'Unknown department.' }

  const rawDoctor = first(sp, 'doctor')
  const providerId = rawDoctor ? parseId(rawDoctor) : null
  if (rawDoctor && providerId === null) return { ok: false, field: 'doctor', error: 'Unknown doctor.' }

  return { ok: true, filters: { from, to, type, status, departmentId, providerId } }
}

/** The query string for these filters (the export link, pagination-free). */
export function registerQueryString(f: RegisterFilters): string {
  const qs = new URLSearchParams({ from: f.from, to: f.to, type: f.type ?? 'all' })
  if (f.status) qs.set('status', f.status)
  if (f.departmentId !== null) qs.set('department', String(f.departmentId))
  if (f.providerId !== null) qs.set('doctor', String(f.providerId))
  return qs.toString()
}

export const ENCOUNTER_TYPE_LABEL: Record<EncounterType, string> = { opd: 'OPD', ipd: 'IPD', lab: 'Lab' }
export const ENCOUNTER_STATUS_LABEL: Record<EncounterStatus, string> = {
  checked_in: 'Checked in', in_consultation: 'In consultation', completed: 'Completed', cancelled: 'Cancelled',
}
export const VISIT_TYPE_LABEL: Record<EncounterVisitType, string> = { new: 'New', follow_up: 'Follow-up', review: 'Review', emergency: 'Emergency' }
const GENDER_LABEL = new Map<string, string>(GENDERS.map((g) => [g.code, g.label]))
export function genderLabel(code: string | null): string {
  return code ? (GENDER_LABEL.get(code) ?? code) : ''
}

// RFC 4180 quoting, plus the OWASP CSV-injection guard: a cell a spreadsheet
// would read as a formula (= + - @, tab, CR) is prefixed with a quote.
function csvCell(value: string | number | null): string {
  let s = value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const CSV_HEADER = ['Date', 'Token', 'UHID', 'Patient', 'Age', 'Sex', 'Type', 'Visit', 'Department', 'Doctor', 'Status', 'Checked in (IST)', 'Completed (IST)']

export function encounterRegisterCsv(rows: EncounterRegisterRow[]): string {
  const lines = [CSV_HEADER.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push([
      formatIsoDate(r.encounterDate),
      r.opdToken,
      r.uhid,
      r.patientName,
      r.ageYears,
      genderLabel(r.gender),
      ENCOUNTER_TYPE_LABEL[r.encounterType],
      VISIT_TYPE_LABEL[r.visitType],
      r.departmentName,
      r.doctorName,
      ENCOUNTER_STATUS_LABEL[r.status],
      formatIstDateTime(r.checkedInAt),
      r.completedAt ? formatIstDateTime(r.completedAt) : null,
    ].map(csvCell).join(','))
  }
  return lines.join('\r\n')
}
