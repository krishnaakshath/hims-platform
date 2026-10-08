// SP7 money invariants (pure, client-safe; integer paise). Messages name the rupee gap so
// the RCM user can see what does not add up.
import { formatPaise } from '@/lib/format'
import { sumPaise } from '@/lib/billing/amounts'
import type { ClaimStatus } from './claim-status'

export interface DisallowanceInput { reasonCode: string; amountPaise: number; patientRecoverable: boolean }

const isWholePaise = (v: number) => Number.isSafeInteger(v)

/** An insurer decision: approved ≤ claimed, and the deductions add up to exactly the gap (ruling 13). */
export function approvalProblems(i: { claimedPaise: number; approvedPaise: number; disallowances: DisallowanceInput[] }): string | null {
  if (!isWholePaise(i.approvedPaise) || i.approvedPaise < 0) return 'Enter the approved amount'
  if (i.approvedPaise > i.claimedPaise) return `The approved amount cannot exceed the claimed amount (${formatPaise(i.claimedPaise)})`
  if (i.disallowances.some((d) => !isWholePaise(d.amountPaise) || d.amountPaise < 1)) return 'Each deduction needs an amount'
  const gap = i.claimedPaise - i.approvedPaise
  if (sumPaise(i.disallowances.map((d) => d.amountPaise)) !== gap) {
    return `Disallowed amounts must add up to the claimed amount less the approved amount (${formatPaise(gap)})`
  }
  return null
}

interface SettlementAmounts { approvedPaise: number; alreadySettledPaise: number; receivedPaise: number; tdsPaise: number; bankChargesPaise: number }

/** A settlement (received + TDS + bank charges) never exceeds the approved amount still due (ruling 5). */
export function settlementProblems(i: SettlementAmounts): string | null {
  if (!isWholePaise(i.receivedPaise) || i.receivedPaise < 1) return 'Enter the amount received'
  if (!isWholePaise(i.tdsPaise) || !isWholePaise(i.bankChargesPaise) || i.tdsPaise < 0 || i.bankChargesPaise < 0) return 'TDS and bank charges cannot be negative'
  const due = Math.max(0, i.approvedPaise - i.alreadySettledPaise)
  if (sumPaise([i.receivedPaise, i.tdsPaise, i.bankChargesPaise]) > due) return `Settlement exceeds the approved amount still due (${formatPaise(due)})`
  return null
}

export function settlementWarnings(i: SettlementAmounts): string[] {
  const out: string[] = []
  if (i.tdsPaise * 10 > i.receivedPaise + i.tdsPaise) out.push('TDS is more than 10% of the gross payment')
  return out
}

export interface ClaimMoney {
  status: ClaimStatus
  claimedPaise: number
  approvedPaise: number | null
  nonRecoverableDisallowedPaise: number
  settledPaise: number
  writtenOffPaise: number
  pendingWriteOffPaise: number
}

const NOTHING_PENDING: readonly ClaimStatus[] = ['withdrawn', 'rejected', 'closed']
const NOTHING_COVERED: readonly ClaimStatus[] = ['draft', 'withdrawn', 'closed']

/**
 * Ruling 5: the part of the bill neither the patient owes nor is yet credited. Before a
 * decision it is the claimed amount; after, the approved amount plus the deductions the
 * hospital absorbs (not patient-recoverable), less settlements and write-offs.
 */
export function claimCoveredPendingPaise(c: ClaimMoney): number {
  // A draft has not been sent, so it covers nothing yet. A rejection keeps covering only the part
  // the hospital absorbs (not patient-recoverable) until it is written off (rulings 5 and 13).
  if (NOTHING_COVERED.includes(c.status)) return 0
  if (c.status === 'rejected') return Math.max(0, c.nonRecoverableDisallowedPaise - c.settledPaise - c.writtenOffPaise)
  const covered = c.approvedPaise === null ? c.claimedPaise : c.approvedPaise + c.nonRecoverableDisallowedPaise
  return Math.max(0, covered - c.settledPaise - c.writtenOffPaise)
}

export function insurerOutstandingPaise(c: ClaimMoney): number {
  if (c.status === 'draft' || NOTHING_PENDING.includes(c.status)) return 0
  return Math.max(0, (c.approvedPaise ?? c.claimedPaise) - c.settledPaise)
}

/** What may still be written off: the absorbed deductions plus any short payment, less write-offs done or pending. */
export function writeOffCeilingPaise(c: ClaimMoney): number {
  if (c.approvedPaise === null) return 0
  const open = c.nonRecoverableDisallowedPaise + Math.max(0, c.approvedPaise - c.settledPaise)
  return Math.max(0, open - c.writtenOffPaise - c.pendingWriteOffPaise)
}

export function closeProblems(c: ClaimMoney & { unreconciledSettlements: number; openQueries: number }): string | null {
  if (c.pendingWriteOffPaise > 0) return 'Decide the pending write-off first'
  if (c.unreconciledSettlements > 0) return 'Reconcile every settlement with the bank first'
  if (c.openQueries > 0) return 'Close the open insurer queries first'
  const pending = claimCoveredPendingPaise(c)
  if (pending > 0) return `${formatPaise(pending)} is still due from the insurer or must be written off`
  return null
}

/** Splits a patient's outstanding balance into "awaiting insurer" and "patient payable". */
export function splitPatientOutstanding(outstandingPaise: number, coveredPendingPaise: number): { coveredPendingPaise: number; patientPayablePaise: number } {
  return { coveredPendingPaise, patientPayablePaise: Math.max(0, outstandingPaise - coveredPendingPaise) }
}
