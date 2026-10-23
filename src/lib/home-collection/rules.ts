// Pure, client-safe home-collection rules. No DB or node: imports. Calendar
// maths is UTC date maths on YYYY-MM-DD strings; "today" comes from the caller
// (IST, via todayIsoIn / istDateOf). Window times are 'HH:MM' IST.
import { addDaysIso, istSlotString } from '@/lib/follow-ups/rules'
import { formatCalendarDate } from '@/lib/india-time'

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

// WS6 T11: the collector's guard at the door, and the handover proof (spec D7).

/** Why a collect may go ahead without the patient's handover code. */
export const HANDOVER_WAIVER_REASONS = ['no_phone', 'sms_unavailable', 'patient_declined'] as const
export type HandoverWaiverReason = (typeof HANDOVER_WAIVER_REASONS)[number]
export const HANDOVER_WAIVER_LABEL: Record<HandoverWaiverReason, string> = {
  no_phone: 'Patient has no phone',
  sms_unavailable: 'SMS is not available',
  patient_declined: 'Patient declined to share the code',
}

export type CollectorVisitRefusal = 'not_assigned' | 'not_collectable' | 'not_due'

/**
 * Whether this session may act at the door for this visit today (YYYY-MM-DD, IST). A collector
 * acts only on a visit assigned to them, checked first so they learn nothing about anyone
 * else's visit; then the visit must still be booked, and its date must have come.
 */
export function collectorVisitRefusal(
  visit: { status: HomeCollectionStatus; collectorUserId: number | null; visitDate: string },
  session: { role: string; userId: number | null },
  todayIso: string,
): CollectorVisitRefusal | null {
  if (session.role === 'collector' && (session.userId === null || visit.collectorUserId !== session.userId)) return 'not_assigned'
  if (visit.status !== 'booked') return 'not_collectable'
  if (visit.visitDate > todayIso) return 'not_due'
  return null
}

/** "This visit is on 24 Oct 2026. It can be collected on that day." */
export function visitNotDueMessage(visitDate: string): string {
  return `This visit is on ${formatCalendarDate(visitDate)}. It can be collected on that day.`
}
// end WS6 T11

// WS6 T12: payment at the door (spec D8).
/** The ledger note on a door payment (cash receipt reference, UPI request note). */
export function doorPaymentNote(visitId: number): string {
  return `Home collection visit #${visitId}`
}

/**
 * What the collector asks for at the door: the sum of the quoted prices of the visit's tests
 * still to be drawn (lab orders carry their tariff quote; they are not yet on any invoice).
 * Unpriced tests add nothing and are counted, so the screen can say so.
 */
export function doorAmountDue(tests: readonly { status: string; quotedPricePaise: number | null }[]): { amountPaise: number; unpriced: number } {
  const due = tests.filter((t) => t.status === 'scheduled')
  return {
    amountPaise: due.reduce((sum, t) => sum + (t.quotedPricePaise ?? 0), 0),
    unpriced: due.filter((t) => t.quotedPricePaise === null).length,
  }
}
// end WS6 T12
