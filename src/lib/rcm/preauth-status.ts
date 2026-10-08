// SP7 pre-authorisation status machine and the reference status SP4 charge capture
// validates against (ruling 7). Pure, client-safe.

export const PREAUTH_STATUSES = [
  'draft', 'requested', 'queried', 'approved', 'enhancement_requested', 'enhancement_queried', 'enhanced', 'rejected', 'cancelled',
] as const
export type PreauthStatus = (typeof PREAUTH_STATUSES)[number]

export const PREAUTH_ACTIONS = [
  'request', 'record_query', 'respond_query', 'approve', 'reject', 'request_enhancement', 'approve_enhancement', 'reject_enhancement', 'cancel',
] as const
export type PreauthAction = (typeof PREAUTH_ACTIONS)[number]

/** Statuses in which an approval is in force (an enhancement in flight keeps the last approval). */
export const LIVE_APPROVED_PREAUTH_STATUSES = ['approved', 'enhancement_requested', 'enhancement_queried', 'enhanced'] as const satisfies readonly PreauthStatus[]

export function isLiveApprovedPreauth(status: PreauthStatus): boolean {
  return (LIVE_APPROVED_PREAUTH_STATUSES as readonly PreauthStatus[]).includes(status)
}

export const PREAUTH_STATUS_LABEL: Record<PreauthStatus, string> = {
  draft: 'Draft',
  requested: 'Requested',
  queried: 'Query from insurer',
  approved: 'Approved',
  enhancement_requested: 'Enhancement requested',
  enhancement_queried: 'Enhancement query',
  enhanced: 'Enhanced',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

/**
 * The status after `action`, or null when the action is not possible from `from`.
 * `reject_enhancement` falls back to the last approval: `enhanced` when an enhancement
 * was approved before, else `approved`.
 */
export function nextPreauthStatus(from: PreauthStatus, action: PreauthAction, ctx?: { enhancedBefore: boolean }): PreauthStatus | null {
  switch (action) {
    case 'request':
      return from === 'draft' ? 'requested' : null
    case 'record_query':
      if (from === 'requested') return 'queried'
      if (from === 'enhancement_requested') return 'enhancement_queried'
      return null
    case 'respond_query':
      if (from === 'queried') return 'requested'
      if (from === 'enhancement_queried') return 'enhancement_requested'
      return null
    case 'approve':
      return from === 'requested' || from === 'queried' ? 'approved' : null
    case 'reject':
      return from === 'requested' || from === 'queried' ? 'rejected' : null
    case 'request_enhancement':
      return from === 'approved' || from === 'enhanced' ? 'enhancement_requested' : null
    case 'approve_enhancement':
      return from === 'enhancement_requested' || from === 'enhancement_queried' ? 'enhanced' : null
    case 'reject_enhancement':
      if (from !== 'enhancement_requested' && from !== 'enhancement_queried') return null
      return ctx?.enhancedBefore ? 'enhanced' : 'approved'
    case 'cancel':
      return from === 'rejected' || from === 'cancelled' ? null : 'cancelled'
    default:
      return null
  }
}

export const PREAUTH_REFERENCE_STATUSES = ['valid', 'not_found', 'not_approved', 'expired', 'payer_mismatch'] as const
export type PreauthReferenceStatus = (typeof PREAUTH_REFERENCE_STATUSES)[number]

/** Checked in order: found, live-approved, same payer (when a payer is given), still valid on the service date. */
export function preauthReferenceStatus(
  p: { status: PreauthStatus; payerIds: number[]; validUntil: string | null } | null,
  ctx: { payerId: number | null; serviceDate: string },
): PreauthReferenceStatus {
  if (p === null) return 'not_found'
  if (!isLiveApprovedPreauth(p.status)) return 'not_approved'
  if (ctx.payerId !== null && !p.payerIds.includes(ctx.payerId)) return 'payer_mismatch'
  if (p.validUntil !== null && p.validUntil < ctx.serviceDate) return 'expired'
  return 'valid'
}
