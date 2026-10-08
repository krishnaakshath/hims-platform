// Pure patient ledger. Positive balance = the patient owes. All sums are BigInt-safe via sumPaise.
import { sumPaise } from './amounts'

export type LedgerEntryKind = 'invoice' | 'credit_note' | 'advance' | 'receipt' | 'refund'
export interface LedgerEntry { kind: LedgerEntryKind; id: number; number: string; at: Date; amountPaise: number; admissionId: number | null }
export interface LedgerSummary {
  invoicedPaise: number; creditedPaise: number; receivedPaise: number; refundedPaise: number
  balancePaise: number; outstandingPaise: number; creditBalancePaise: number
}

const KIND_ORDER: Record<LedgerEntryKind, number> = { invoice: 0, credit_note: 1, advance: 2, receipt: 3, refund: 4 }
const SIGN: Record<LedgerEntryKind, 1 | -1> = { invoice: 1, refund: 1, credit_note: -1, advance: -1, receipt: -1 }

export function computeLedger(entries: LedgerEntry[]): { rows: (LedgerEntry & { balancePaise: number })[]; summary: LedgerSummary } {
  const sorted = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id)
  const signed: number[] = []
  const rows = sorted.map((entry) => {
    signed.push(SIGN[entry.kind] * entry.amountPaise)
    return { ...entry, balancePaise: sumPaise(signed) }
  })
  const of = (...kinds: LedgerEntryKind[]) => sumPaise(entries.filter((e) => kinds.includes(e.kind)).map((e) => e.amountPaise))
  const invoicedPaise = of('invoice')
  const creditedPaise = of('credit_note')
  const receivedPaise = of('advance', 'receipt')
  const refundedPaise = of('refund')
  const balancePaise = sumPaise([invoicedPaise, refundedPaise, -creditedPaise, -receivedPaise])
  return {
    rows,
    summary: { invoicedPaise, creditedPaise, receivedPaise, refundedPaise, balancePaise, outstandingPaise: Math.max(0, balancePaise), creditBalancePaise: Math.max(0, -balancePaise) },
  }
}

/** Advances minus refunds carrying this admission id, floored at 0. */
export function admissionDepositPaise(entries: LedgerEntry[], admissionId: number): number {
  const mine = entries.filter((e) => e.admissionId === admissionId)
  const advances = sumPaise(mine.filter((e) => e.kind === 'advance').map((e) => e.amountPaise))
  const refunds = sumPaise(mine.filter((e) => e.kind === 'refund').map((e) => e.amountPaise))
  return Math.max(0, sumPaise([advances, -refunds]))
}
