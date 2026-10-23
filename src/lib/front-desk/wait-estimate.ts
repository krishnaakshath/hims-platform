// WS6 T9 (spec D6): the front desk's OPD wait estimate -- the patients still waiting ahead
// times the doctor's slot length. Shown on the check-in dialog and the token slip; it is a
// guide for the patient, not a promise, so it is capped.

/** Assumed minutes per patient when the doctor's slot length is unknown. */
export const DEFAULT_MINUTES_PER_PATIENT = 10
/** Longest estimate shown (4 hours). */
export const MAX_WAIT_MINUTES = 240

/** Minutes until the patient is likely seen; 0 with nobody ahead; null for a nonsensical count. */
export function estimateWaitMinutes(waitingAhead: number, slotMinutes: number | null): number | null {
  if (!Number.isFinite(waitingAhead) || waitingAhead < 0) return null
  if (waitingAhead === 0) return 0
  const perPatient = slotMinutes !== null && slotMinutes > 0 ? slotMinutes : DEFAULT_MINUTES_PER_PATIENT
  return Math.min(Math.round(waitingAhead) * perPatient, MAX_WAIT_MINUTES)
}
