import { chargeStatusEnum } from '@/db/schema'

// DB-free by design -- this is the one shared definition of the charge
// status workflow, safe to import from both server code (API routes) and
// client components (ChargesTable's status-action buttons), so the two
// never drift into disagreeing about which transitions are legal.
export type ChargeStatus = (typeof chargeStatusEnum.enumValues)[number]

export const CHARGE_STATUS_LABELS: Record<ChargeStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  submitted: 'Submitted',
}

// Forward-only workflow, with an explicit "send back for rework" step at each
// stage after the first -- a charge sent back for rework just moves back to
// `draft`/`pending_approval` rather than introducing a separate rework enum
// value.
export const ALLOWED_TRANSITIONS: Record<ChargeStatus, ChargeStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'draft'],
  approved: ['submitted', 'pending_approval'],
  submitted: [],
}

export function isAllowedChargeTransition(from: ChargeStatus, to: ChargeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

// One label per "from -> to" edge in ALLOWED_TRANSITIONS, so a forward move
// and a "send back" move to the same status can read differently.
const TRANSITION_LABELS: Partial<Record<ChargeStatus, Partial<Record<ChargeStatus, string>>>> = {
  draft: { pending_approval: 'Send for Approval' },
  pending_approval: { approved: 'Approve', draft: 'Send Back to Draft' },
  approved: { submitted: 'Submit', pending_approval: 'Send Back for Approval' },
}

// The UI's per-row action buttons, derived from the same ALLOWED_TRANSITIONS
// this file exports -- never a hand-maintained second copy of the workflow.
export function nextStatusActions(from: ChargeStatus): { label: string; next: ChargeStatus }[] {
  return ALLOWED_TRANSITIONS[from].map((next) => ({ next, label: TRANSITION_LABELS[from]?.[next] ?? CHARGE_STATUS_LABELS[next] }))
}
