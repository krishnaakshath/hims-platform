import { describe, it, expect } from 'vitest'
import {
  approvalProblems, settlementProblems, settlementWarnings, claimCoveredPendingPaise, insurerOutstandingPaise,
  writeOffCeilingPaise, closeProblems, splitPatientOutstanding,
} from '@/lib/rcm/amounts'

describe('RCM money rules', () => {
  it('approval amounts must reconcile', () => {
    const d = [{ reasonCode: 'NME', amountPaise: 15_000_00, patientRecoverable: true }]
    expect(approvalProblems({ claimedPaise: 100_000_00, approvedPaise: 80_000_00, disallowances: d })).toBe('Disallowed amounts must add up to the claimed amount less the approved amount (₹20,000.00)')
    expect(approvalProblems({ claimedPaise: 100_000_00, approvedPaise: 85_000_00, disallowances: d })).toBeNull()
    expect(approvalProblems({ claimedPaise: 100, approvedPaise: 101, disallowances: [] })).toMatch(/cannot exceed/)
    expect(approvalProblems({ claimedPaise: 100, approvedPaise: -1, disallowances: [] })).toBe('Enter the approved amount')
    expect(approvalProblems({ claimedPaise: 100, approvedPaise: 1.5, disallowances: [] })).toBe('Enter the approved amount')
    expect(approvalProblems({ claimedPaise: 100, approvedPaise: 100, disallowances: [{ reasonCode: 'X', amountPaise: 0, patientRecoverable: false }] })).toBe('Each deduction needs an amount')
    expect(approvalProblems({ claimedPaise: 100, approvedPaise: 0, disallowances: [{ reasonCode: 'EXCL', amountPaise: 100, patientRecoverable: true }] })).toBeNull()
  })
  it('settlement above the approved amount still due is refused; TDS over 10% warns', () => {
    const s = { approvedPaise: 80_000_00, alreadySettledPaise: 70_000_00, receivedPaise: 9_000_00, tdsPaise: 1_000_00, bankChargesPaise: 1 }
    expect(settlementProblems(s)).toBe('Settlement exceeds the approved amount still due (₹10,000.00)')
    expect(settlementProblems({ ...s, bankChargesPaise: 0 })).toBeNull()
    expect(settlementProblems({ ...s, receivedPaise: 0 })).toBe('Enter the amount received')
    expect(settlementProblems({ ...s, tdsPaise: -1 })).toBe('TDS and bank charges cannot be negative')
    expect(settlementWarnings({ ...s, receivedPaise: 8_000_00, tdsPaise: 2_000_00, bankChargesPaise: 0 })).toEqual(['TDS is more than 10% of the gross payment'])
    expect(settlementWarnings({ ...s, receivedPaise: 9_000_00, tdsPaise: 1_000_00, bankChargesPaise: 0 })).toEqual([])
  })
  const M = { status: 'partially_approved' as const, claimedPaise: 100_000_00, approvedPaise: 80_000_00, nonRecoverableDisallowedPaise: 5_000_00, settledPaise: 0, writtenOffPaise: 0, pendingWriteOffPaise: 0 }
  it('covered pending excludes the patient-recoverable deduction', () => {
    expect(claimCoveredPendingPaise(M)).toBe(85_000_00); expect(claimCoveredPendingPaise({ ...M, approvedPaise: null, status: 'submitted' })).toBe(100_000_00)
    expect(claimCoveredPendingPaise({ ...M, status: 'rejected' })).toBe(5_000_00); expect(splitPatientOutstanding(100_000_00, 85_000_00)).toEqual({ coveredPendingPaise: 85_000_00, patientPayablePaise: 15_000_00 })
    expect(splitPatientOutstanding(10, 85)).toEqual({ coveredPendingPaise: 85, patientPayablePaise: 0 })
  })
  it('insurer outstanding', () => {
    expect(insurerOutstandingPaise({ ...M, settledPaise: 30_000_00 })).toBe(50_000_00)
    expect(insurerOutstandingPaise({ ...M, status: 'draft' })).toBe(0)
    expect(insurerOutstandingPaise({ ...M, status: 'submitted', approvedPaise: null })).toBe(100_000_00)
  })
  it('write-off ceiling', () => {
    expect(writeOffCeilingPaise({ ...M, settledPaise: 78_000_00 })).toBe(7_000_00)
    expect(writeOffCeilingPaise({ ...M, settledPaise: 78_000_00, pendingWriteOffPaise: 7_000_00 })).toBe(0); expect(writeOffCeilingPaise({ ...M, approvedPaise: null })).toBe(0)
  })
  it('close is blocked in order', () => {
    const settled = { ...M, status: 'settled' as const, settledPaise: 80_000_00, unreconciledSettlements: 0, openQueries: 0 }
    expect(closeProblems({ ...settled, pendingWriteOffPaise: 1, unreconciledSettlements: 1 })).toBe('Decide the pending write-off first')
    expect(closeProblems({ ...settled, unreconciledSettlements: 1 })).toBe('Reconcile every settlement with the bank first')
    expect(closeProblems({ ...settled, openQueries: 1 })).toBe('Close the open insurer queries first')
    expect(closeProblems(settled)).toBe('₹5,000.00 is still due from the insurer or must be written off')
    expect(closeProblems({ ...settled, writtenOffPaise: 5_000_00 })).toBeNull()
  })
  it('sums past 2^31 exactly', () => { expect(claimCoveredPendingPaise({ ...M, claimedPaise: 3_000_000_000, approvedPaise: null, status: 'submitted' })).toBe(3_000_000_000) })

  // Whole-branch review findings 1 and 3.
  it('a rejection the hospital absorbs stays covered until written off; a draft covers nothing yet', () => {
    const rejected = { ...M, status: 'rejected' as const, approvedPaise: 0, nonRecoverableDisallowedPaise: 100_000_00 }
    expect(claimCoveredPendingPaise(rejected)).toBe(100_000_00)
    expect(claimCoveredPendingPaise({ ...rejected, nonRecoverableDisallowedPaise: 0 })).toBe(0)
    expect(claimCoveredPendingPaise({ ...rejected, writtenOffPaise: 100_000_00 })).toBe(0)
    expect(closeProblems({ ...rejected, unreconciledSettlements: 0, openQueries: 0 })).toBe('₹1,00,000.00 is still due from the insurer or must be written off')
    expect(claimCoveredPendingPaise({ ...M, status: 'draft', approvedPaise: null })).toBe(0)
  })
})

