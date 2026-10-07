// Pure, client-safe follow-up rules. No DB or node: imports. All calendar maths
// is UTC date maths on YYYY-MM-DD strings; business "today" comes from the
// caller (IST, via todayIsoIn / istDateOf).
import { istDateOf } from '@/lib/india-time'
import { normalizeVisitReason } from '@/lib/notification-templates'

export const FOLLOW_UP_STATUSES = ['planned', 'scheduled', 'completed', 'missed', 'cancelled'] as const
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

export const INTERVAL_UNITS = ['days', 'weeks', 'months'] as const
export type IntervalUnit = (typeof INTERVAL_UNITS)[number]
export interface FollowUpInterval { value: number; unit: IntervalUnit }

export type FollowUpTiming =
  | { kind: 'date'; dueDate: string }
  | { kind: 'interval'; interval: FollowUpInterval }

export const DEFAULT_WINDOW_DAYS_BEFORE = 3
export const DEFAULT_WINDOW_DAYS_AFTER = 7
export const MISSED_GRACE_DAYS = 14
export const UPCOMING_HORIZON_DAYS = 30
export const MAX_DUE_MONTHS_AHEAD = 24

function parts(dateIso: string): [number, number, number] {
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number)
  return [y, m, d]
}
function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = parts(dateIso)
  return fmt(Date.UTC(y, m - 1, d + days))
}

/** Whole calendar days from `fromIso` to `toIso` (YYYY-MM-DD; negative when earlier). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = parts(fromIso)
  const [ty, tm, td] = parts(toIso)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

export function addMonthsIso(dateIso: string, months: number): string {
  const [y, m, d] = parts(dateIso)
  const first = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return fmt(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay)))
}

export function resolveFollowUpDates(
  timing: FollowUpTiming,
  baseIso: string,
  windowDaysBefore = DEFAULT_WINDOW_DAYS_BEFORE,
  windowDaysAfter = DEFAULT_WINDOW_DAYS_AFTER,
): { dueDate: string; windowStart: string; windowEnd: string; interval: FollowUpInterval | null } {
  let dueDate: string
  let interval: FollowUpInterval | null = null
  if (timing.kind === 'date') {
    dueDate = timing.dueDate
  } else {
    interval = timing.interval
    const { value, unit } = interval
    dueDate = unit === 'days' ? addDaysIso(baseIso, value) : unit === 'weeks' ? addDaysIso(baseIso, 7 * value) : addMonthsIso(baseIso, value)
  }
  return { dueDate, windowStart: addDaysIso(dueDate, -windowDaysBefore), windowEnd: addDaysIso(dueDate, windowDaysAfter), interval }
}

export function dueDateProblem(dueIso: string, todayIso: string): string | null {
  if (dueIso < todayIso) return 'The follow-up date cannot be in the past.'
  // Calendar math (M5): "within 2 years" is today + 24 months, so a 24-month
  // interval is valid even when it spans a leap day (731 days).
  if (dueIso > addMonthsIso(todayIso, MAX_DUE_MONTHS_AHEAD)) return 'The follow-up date must be within 2 years.'
  return null
}

// Declared locally: src/lib/queries/appointments.ts imports the DB.
export type ApptStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'
export interface FollowUpStatusInput {
  status: FollowUpStatus
  windowEnd: string
  appointment: { status: ApptStatus; startsAt: Date } | null
}

export function deriveFollowUpStatus(input: FollowUpStatusInput, todayIso: string, graceDays = MISSED_GRACE_DAYS): FollowUpStatus {
  const { status, windowEnd, appointment } = input
  if (status === 'cancelled' || status === 'completed' || status === 'missed') return status
  if (appointment?.status === 'completed') return 'completed'
  if (appointment?.status === 'no_show') return 'missed'
  if (appointment?.status === 'scheduled') {
    const apptDay = istDateOf(appointment.startsAt)
    const anchor = apptDay > windowEnd ? apptDay : windowEnd
    return todayIso > addDaysIso(anchor, graceDays) ? 'missed' : 'scheduled'
  }
  return todayIso > addDaysIso(windowEnd, graceDays) ? 'missed' : 'planned'
}

export type RecallBucket = 'upcoming' | 'due' | 'overdue' | 'scheduled' | 'missed' | 'closed'

export function recallBucket(status: FollowUpStatus, windowStart: string, windowEnd: string, todayIso: string): RecallBucket {
  if (status === 'completed' || status === 'cancelled') return 'closed'
  if (status === 'missed') return 'missed'
  if (status === 'scheduled') return 'scheduled'
  if (todayIso < windowStart) return 'upcoming'
  if (todayIso > windowEnd) return 'overdue'
  return 'due'
}

export function isOpenFollowUp(status: FollowUpStatus): boolean {
  return status === 'planned' || status === 'scheduled' || status === 'missed'
}

export const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string> = {
  planned: 'Not booked', scheduled: 'Booked', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled',
}
export const PORTAL_FOLLOW_UP_LABEL: Record<FollowUpStatus, string> = {
  planned: 'Due, please book', scheduled: 'Booked', completed: 'Done', missed: 'Missed, please contact us', cancelled: 'Cancelled',
}

export function followUpVisitReason(reason: string): string {
  return normalizeVisitReason(`Follow-up: ${reason}`)
}

export function istSlotString(dateIso: string, hhmm: string): string {
  return `${dateIso}T${hhmm}:00+05:30`
}
