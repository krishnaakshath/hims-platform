// SP7 claim status machine, the approval action and worklist classification. Pure, client-safe.

export const CLAIM_STATUSES = [
  'draft', 'submitted', 'queried', 'approved', 'partially_approved', 'rejected', 'appealed', 'settled', 'closed', 'withdrawn',
] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

export const CLAIM_ACTIONS = [
  'submit', 'record_query', 'respond_query', 'record_approval', 'record_partial_approval', 'record_rejection',
  'appeal', 'record_settlement', 'close', 'reopen', 'withdraw',
] as const
export type ClaimAction = (typeof CLAIM_ACTIONS)[number]

export const CLAIM_EVENT_ACTIONS = [...CLAIM_ACTIONS, 'note'] as const
export type ClaimEventAction = (typeof CLAIM_EVENT_ACTIONS)[number]

/** Actions that send a new package (version) to the insurer. */
export const OUTBOUND_CLAIM_ACTIONS = ['submit', 'respond_query', 'appeal'] as const satisfies readonly ClaimAction[]

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  queried: 'Query from insurer',
  approved: 'Approved',
  partially_approved: 'Partially approved',
  rejected: 'Rejected',
  appealed: 'Appealed',
  settled: 'Settled',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
}

export function nextClaimStatus(from: ClaimStatus, action: ClaimAction, ctx: { hasSettlement: boolean }): ClaimStatus | null {
  switch (action) {
    case 'submit':
      return from === 'draft' ? 'submitted' : null
    case 'record_query':
      return from === 'submitted' || from === 'appealed' ? 'queried' : null
    case 'respond_query':
      return from === 'queried' ? 'submitted' : null
    case 'record_approval':
      return from === 'submitted' || from === 'appealed' ? 'approved' : null
    case 'record_partial_approval':
      return from === 'submitted' || from === 'appealed' ? 'partially_approved' : null
    case 'record_rejection':
      return from === 'submitted' || from === 'queried' || from === 'appealed' ? 'rejected' : null
    case 'appeal':
      return from === 'rejected' || from === 'partially_approved' || from === 'settled' ? 'appealed' : null
    case 'record_settlement':
      return from === 'approved' || from === 'partially_approved' || from === 'settled' ? 'settled' : null
    case 'close':
      return from === 'settled' || from === 'rejected' ? 'closed' : null
    case 'reopen':
      return from === 'closed' ? (ctx.hasSettlement ? 'settled' : 'rejected') : null
    case 'withdraw':
      return from === 'draft' || from === 'submitted' || from === 'queried' ? 'withdrawn' : null
    default:
      return null
  }
}

/** Ruling 13: the server decides full or partial approval from the amounts. */
export function approvalActionFor(claimedPaise: number, approvedPaise: number): 'record_approval' | 'record_partial_approval' {
  return approvedPaise >= claimedPaise ? 'record_approval' : 'record_partial_approval'
}

export const CLAIM_WORKLISTS = ['to_submit', 'queried', 'awaiting_insurer', 'to_reconcile', 'denied'] as const
export type ClaimWorklist = (typeof CLAIM_WORKLISTS)[number]
export const CLAIM_WORKLIST_LABEL: Record<ClaimWorklist, string> = {
  to_submit: 'To submit',
  queried: 'Insurer queries',
  awaiting_insurer: 'Awaiting insurer',
  to_reconcile: 'To reconcile',
  denied: 'Denied or short-paid',
}

/** Every worklist a claim belongs on, in CLAIM_WORKLISTS order (lists may overlap). */
export function claimWorklists(c: { status: ClaimStatus; unreconciledSettlements: number; openDenialPaise: number }): ClaimWorklist[] {
  const on = new Set<ClaimWorklist>()
  if (c.status === 'draft') on.add('to_submit')
  if (c.status === 'queried') on.add('queried')
  if (c.status === 'submitted' || c.status === 'appealed' || c.status === 'approved' || c.status === 'partially_approved') on.add('awaiting_insurer')
  if (c.unreconciledSettlements > 0) on.add('to_reconcile')
  if (c.status === 'rejected' || ((c.status === 'partially_approved' || c.status === 'settled') && c.openDenialPaise > 0)) on.add('denied')
  return CLAIM_WORKLISTS.filter((w) => on.has(w))
}
