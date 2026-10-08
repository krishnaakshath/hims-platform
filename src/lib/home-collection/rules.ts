// Pure, client-safe home-collection rules. No DB or node: imports. Calendar
// maths is UTC date maths on YYYY-MM-DD strings; "today" comes from the caller
// (IST, via todayIsoIn / istDateOf). Window times are 'HH:MM' IST.
import { addDaysIso, istSlotString } from '@/lib/follow-ups/rules'

export const HOME_COLLECTION_STATUSES = ['booked', 'collected', 'cancelled'] as const
export type HomeCollectionStatus = (typeof HOME_COLLECTION_STATUSES)[number]

export const RESCHEDULE_REASONS = ['patient_request', 'collector_unavailable', 'address_issue', 'other'] as const
export type RescheduleReason = (typeof RESCHEDULE_REASONS)[number]

export const VISIT_CANCEL_REASONS = [
  'patient_request', 'patient_unavailable', 'patient_refused', 'address_not_found', 'tests_cancelled', 'other',
] as const
export type VisitCancelReason = (typeof VISIT_CANCEL_REASONS)[number]

/** The subset a collector may record at the door. */
export const COLLECTOR_CANCEL_REASONS = ['patient_unavailable', 'patient_refused', 'address_not_found'] as const

export const RESCHEDULE_REASON_LABEL: Record<RescheduleReason, string> = {
  patient_request: 'Patient asked to change',
  collector_unavailable: 'Collector unavailable',
  address_issue: 'Address issue',
  other: 'Other',
}

export const VISIT_CANCEL_REASON_LABEL: Record<VisitCancelReason, string> = {
  patient_request: 'Patient asked to cancel',
  patient_unavailable: 'Patient not available',
  patient_refused: 'Patient refused sample collection',
  address_not_found: 'Address not found',
  tests_cancelled: 'Tests cancelled',
  other: 'Other',
}

export const MAX_BOOKING_DAYS_AHEAD = 30
export const MIN_BOOKING_LEAD_MINUTES = 60
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** Both arguments are YYYY-MM-DD; ISO dates compare correctly as strings. */
export function bookingDateProblem(visitDate: string, todayIso: string): string | null {
  if (visitDate < todayIso) return 'Pick today or a later date.'
  if (visitDate > addDaysIso(todayIso, MAX_BOOKING_DAYS_AHEAD)) {
    return `Home collection can be booked up to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`
  }
  return null
}

/** True when the window (IST) starts less than 60 minutes from `now`, or has started. */
export function windowClosed(visitDate: string, startTime: string, now: Date): boolean {
  const start = new Date(istSlotString(visitDate, startTime)).getTime()
  return start - now.getTime() < MIN_BOOKING_LEAD_MINUTES * 60_000
}

/** Half-open intervals: windows that only touch do not overlap. */
export function windowsOverlap(
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime
}
