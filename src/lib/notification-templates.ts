// Fixed, pure patient-notification copy. No DB access, no patient-supplied text.
// The only free-text field (visitReason) is normalized by normalizeVisitReason.
//
// Date/time rule (Wave A): patient messages state the visit in hospital time,
// Asia/Kolkata, with an explicit "IST" label -- never in the server's own zone
// (UTC on Vercel would tell a 09:00 IST patient "3:30 AM"). Day and time come
// from the same pure IST formatters, so they always agree near midnight.
import { formatIstLongDate, formatIstTime } from '@/lib/india-time'

export interface VisitConfirmationInput {
  providerName: string
  startsAt: Date
  visitReason: string
  visitType: 'inpatient' | 'outpatient'
}

/** "Tuesday, 3 November 2026" (IST calendar day). */
export function formatVisitDate(d: Date): string {
  return formatIstLongDate(d)
}

/** "9:00 am IST". */
export function formatVisitTime(d: Date): string {
  return formatIstTime(d, { label: true })
}

export const WHAT_TO_BRING: readonly string[] = [
  'A photo ID (for example Aadhaar, PAN card, voter ID or passport)',
  'Your health insurance, TPA or government scheme card, if you have one',
  'A current list of everything you take — prescriptions, over-the-counter medicines, vitamins and supplements — with the dose for each',
  "Any forms we sent you that you haven't finished yet",
  'A way to pay (cash, UPI or card) for any amount due at the visit',
]

export const INPATIENT_OVERNIGHT_BAG =
  'An overnight bag — a few days of comfortable clothes and toiletries, and your medicines in their original labelled containers'

export const VISIT_REASON_MAX_LENGTH = 140
export const VISIT_REASON_FALLBACK = 'General visit'

// The reason originates as free text (check-in, booking), so it is normalized
// wherever it is shown to the patient: whitespace (including newlines, which
// could otherwise forge extra lines in a message) collapses to single spaces,
// and the result is capped at VISIT_REASON_MAX_LENGTH with an ellipsis.
// Length is measured in UTF-16 units -- the same unit zod's .max() and an
// input's maxLength use -- and a surrogate pair is never split.
export function normalizeVisitReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return VISIT_REASON_FALLBACK
  if (collapsed.length <= VISIT_REASON_MAX_LENGTH) return collapsed
  const budget = VISIT_REASON_MAX_LENGTH - 1 // room for the ellipsis
  let out = ''
  for (const ch of collapsed) {
    if (out.length + ch.length > budget) break
    out += ch
  }
  return out.trimEnd() + '…'
}

export function buildVisitConfirmationBody(input: VisitConfirmationInput): string {
  const items = input.visitType === 'inpatient' ? [...WHAT_TO_BRING, INPATIENT_OVERNIGHT_BAG] : [...WHAT_TO_BRING]
  return [
    'Your visit is confirmed.',
    '',
    `${input.providerName} will see you on ${formatVisitDate(input.startsAt)} at ${formatVisitTime(input.startsAt)}.`,
    '',
    `Reason for visit: ${normalizeVisitReason(input.visitReason)}`,
    '',
    'Please bring with you:',
    ...items.map((i) => `• ${i}`),
    '',
    "If this time doesn't work, reply to this message and our front desk will help you change it.",
  ].join('\n')
}
