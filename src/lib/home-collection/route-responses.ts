// SP5: fixed error bodies for the home-collection routes. Never echoes input; the role gate is
// NOT here (every route checks its allowlist inline, right after requireSession()).
import { NextResponse } from 'next/server'
import { brand } from '@/lib/brand'
import type { Session } from '@/lib/auth'
import { errorResponse } from '@/lib/labs/route-responses'
import { notifyPatientSafely, type NotifyOutcome } from '@/lib/queries/notifications'

export const VISIT_NOT_FOUND = 'Home collection visit not found'
export const INVALID_VISIT_ID = 'Invalid visit id'

const BOOKING_ERROR: Record<string, { status: number; error: string }> = {
  window_not_found: { status: 404, error: 'Collection window not found' },
  window_closed: { status: 409, error: 'That collection window has already started or is too close to book.' },
  not_in_service_area: { status: 409, error: 'That address is outside the home-collection service area. The patient can visit the lab instead.' },
  order_not_bookable: { status: 409, error: 'One or more tests are already booked, collected, cancelled, or cannot be collected at home.' },
  slot_full: { status: 409, error: 'That collection window is full. Pick another window.' },
  already_booked: { status: 409, error: 'This patient already has a home collection in that window.' },
  patient_not_found: { status: 404, error: 'Patient not found' },
  same_slot: { status: 400, error: 'Pick a different date or window.' },
  not_reschedulable: { status: 409, error: 'Only a booked visit can be rescheduled.' },
  not_found: { status: 404, error: VISIT_NOT_FOUND },
}

/** Book / reschedule refusals. `invalid_date` carries its own fixed message from the rules. */
export function bookingError(result: { error: string; message?: string }) {
  if (result.error === 'invalid_date') return errorResponse(400, result.message ?? 'Pick a valid date.')
  const mapped = BOOKING_ERROR[result.error] ?? { status: 409, error: 'This booking could not be changed.' }
  return errorResponse(mapped.status, mapped.error)
}

export const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 })

type VisitNotice =
  | { kind: 'booked'; visit: { id: number; patientId: string; visitDate: string; windowLabel: string } }
  | { kind: 'rescheduled'; visit: { id: number; patientId: string; visitDate: string; windowLabel: string; rescheduleCount: number } }
  | { kind: 'cancelled'; visit: { id: number; patientId: string; visitDate: string } }

/**
 * The patient notice for a visit change. Call only AFTER the change has committed; it never
 * throws (notifyPatientSafely). The dedupe key is stable per change, so a retried request does
 * not notify twice. Texts carry the hospital name, date and window label only.
 */
export async function notifyVisitChange(session: Session, n: VisitNotice): Promise<NotifyOutcome | 'error'> {
  const related = { type: 'home_collection_visit' as const, id: n.visit.id }
  if (n.kind === 'booked') {
    return notifyPatientSafely(session, {
      patientId: n.visit.patientId,
      templateKey: 'home_collection_booked',
      vars: { hospitalName: brand.name, visitDate: n.visit.visitDate, windowLabel: n.visit.windowLabel },
      related,
      dedupeKey: `home_collection_booked:visit=${n.visit.id}`,
    })
  }
  if (n.kind === 'rescheduled') {
    return notifyPatientSafely(session, {
      patientId: n.visit.patientId,
      templateKey: 'home_collection_rescheduled',
      vars: { hospitalName: brand.name, visitDate: n.visit.visitDate, windowLabel: n.visit.windowLabel },
      related,
      dedupeKey: `home_collection_rescheduled:visit=${n.visit.id}:n=${n.visit.rescheduleCount}`,
    })
  }
  return notifyPatientSafely(session, {
    patientId: n.visit.patientId,
    templateKey: 'home_collection_cancelled',
    vars: { hospitalName: brand.name, visitDate: n.visit.visitDate },
    related,
    dedupeKey: `home_collection_cancelled:visit=${n.visit.id}`,
  })
}
