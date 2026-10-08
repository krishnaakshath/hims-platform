// SP7 ageing buckets and SLA flags (pure, client-safe). Dates are IST calendar dates
// (YYYY-MM-DD); day arithmetic is done in UTC on the date strings so no zone can shift it.
import type { ClaimStatus } from './claim-status'
import type { PreauthStatus } from './preauth-status'

export const AGING_BUCKETS = [
  { label: '0-30', min: 0, max: 30 },
  { label: '31-60', min: 31, max: 60 },
  { label: '61-90', min: 61, max: 90 },
  { label: '91-180', min: 91, max: 180 },
  { label: '181+', min: 181, max: Infinity },
] as const

export function agingBucketLabel(days: number): string {
  const d = Math.max(0, days)
  return (AGING_BUCKETS.find((b) => d >= b.min && d <= b.max) ?? AGING_BUCKETS[AGING_BUCKETS.length - 1]).label
}

const DAY_MS = 24 * 60 * 60 * 1000
const utcOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))

/** Calendar days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((utcOf(toIso) - utcOf(fromIso)) / DAY_MS)
}

function addDays(iso: string, days: number): string {
  return new Date(utcOf(iso) + days * DAY_MS).toISOString().slice(0, 10)
}

export const SLA_FLAGS = ['submission_due_soon', 'submission_overdue', 'query_due_soon', 'query_overdue', 'settlement_overdue', 'preauth_decision_overdue'] as const
export type SlaFlag = (typeof SLA_FLAGS)[number]
export const SLA_FLAG_LABEL: Record<SlaFlag, string> = {
  submission_due_soon: 'Submission due soon',
  submission_overdue: 'Submission overdue',
  query_due_soon: 'Query reply due soon',
  query_overdue: 'Query reply overdue',
  settlement_overdue: 'Settlement overdue',
  preauth_decision_overdue: 'Pre-auth decision overdue',
}

const AWAITING_SETTLEMENT: readonly ClaimStatus[] = ['submitted', 'queried', 'approved', 'partially_approved', 'appealed']

export function claimSlaFlags(i: {
  status: ClaimStatus
  episodeEndDate: string | null
  firstSubmittedOn: string | null
  openQueryDueDates: string[]
  today: string
  payer: { submissionWindowDays: number; claimSettlementSlaDays: number }
}): SlaFlag[] {
  const on = new Set<SlaFlag>()
  if (i.status === 'draft' && i.episodeEndDate !== null) {
    const deadline = addDays(i.episodeEndDate, i.payer.submissionWindowDays)
    if (i.today > deadline) on.add('submission_overdue')
    else if (i.today >= addDays(deadline, -2)) on.add('submission_due_soon')
  }
  if (i.openQueryDueDates.some((d) => d < i.today)) on.add('query_overdue')
  else if (i.openQueryDueDates.some((d) => d >= i.today && d <= addDays(i.today, 2))) on.add('query_due_soon')
  if (AWAITING_SETTLEMENT.includes(i.status) && i.firstSubmittedOn !== null && i.today > addDays(i.firstSubmittedOn, i.payer.claimSettlementSlaDays)) {
    on.add('settlement_overdue')
  }
  return SLA_FLAGS.filter((f) => on.has(f))
}

/** A cashless request (or enhancement) still undecided after the payer's SLA hours (ruling 14). */
export function preauthDecisionOverdue(i: { status: PreauthStatus; lastRequestedAt: Date | null; now: Date; preauthSlaHours: number }): boolean {
  if (i.status !== 'requested' && i.status !== 'enhancement_requested') return false
  if (i.lastRequestedAt === null) return false
  return i.now.getTime() - i.lastRequestedAt.getTime() > i.preauthSlaHours * 60 * 60 * 1000
}
