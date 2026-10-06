// Fixed, pure patient-notification copy. No DB access, no patient-supplied text.
// The only free-text field (visitReason) is normalized by normalizeVisitReason.
//
// Date/time rule (src/lib/queries/reports.ts:24-29): use LOCAL formatters only and
// never mix toISOString() (UTC) with a local formatter, or visits near midnight
// render on the wrong calendar day. practiceTimezone is deliberately unread.

export interface VisitConfirmationInput {
  providerName: string
  startsAt: Date
  visitReason: string
  visitType: 'inpatient' | 'outpatient'
}

// Node's ICU emits U+202F (narrow no-break space) / U+00A0 before AM/PM; normalize to ASCII.
function asciiSpaces(s: string): string {
  return s.replace(/[  ]/g, ' ')
}

export function formatVisitDate(d: Date): string {
  return asciiSpaces(
    d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
  )
}

export function formatVisitTime(d: Date): string {
  return asciiSpaces(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
}

export const WHAT_TO_BRING: readonly string[] = [
  'A photo ID',
  'Your insurance card',
  'A current list of everything you take — prescriptions, over-the-counter medicines, vitamins and supplements — with the dose for each',
  "Any forms we sent you that you haven't finished yet",
  'A payment method, in case there is a copay due at the visit',
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
