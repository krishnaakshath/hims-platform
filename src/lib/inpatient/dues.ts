// WS3 T5: discharge dues arithmetic (spec 3.2 item 13). Pure; integer paise; BigInt-safe sums.
// dues = non-void charge lines (taxable + intra-state GST) - net advances - receipts - insurer share,
// insurer share = min(approved pre-auth, payer-billed lines), 0 without an approved pre-auth.
import { sumPaise } from '@/lib/billing/amounts'
import { lineTax } from '@/lib/billing/gst'

export interface DuesInput {
  lines: { taxablePaise: number; gstRateBp: number; payerId: number | null }[]
  netAdvancesPaise: number
  receiptsPaise: number
  approvedPreauthPaise: number | null
}

export interface DischargeDues {
  chargesPaise: number
  payerChargesPaise: number
  insurerSharePaise: number
  paidPaise: number
  outstandingPaise: number
  creditPaise: number
}

export function computeDischargeDues(i: DuesInput): DischargeDues {
  const totals = i.lines.map((l) => ({ total: lineTax(l.taxablePaise, l.gstRateBp, 'intra').totalPaise, payer: l.payerId !== null }))
  const chargesPaise = sumPaise(totals.map((t) => t.total))
  const payerChargesPaise = sumPaise(totals.filter((t) => t.payer).map((t) => t.total))
  const insurerSharePaise = Math.min(Math.max(0, i.approvedPreauthPaise ?? 0), payerChargesPaise)
  const paidPaise = sumPaise([i.netAdvancesPaise, i.receiptsPaise])
  const balance = sumPaise([chargesPaise, -insurerSharePaise, -paidPaise])
  return {
    chargesPaise, payerChargesPaise, insurerSharePaise, paidPaise,
    outstandingPaise: Math.max(0, balance),
    creditPaise: Math.max(0, -balance),
  }
}

/**
 * Does the latest clearance still cover today's dues? Only when no charge was added after it
 * (charges have not grown) and the outstanding is no larger than what was cleared; a clearance
 * with an outstanding amount must carry an override reason (the table's check enforces it too).
 */
export function clearanceIsCurrent(
  c: { chargesPaise: number; overrideReason: string | null; outstandingPaise: number } | null,
  now: DischargeDues,
): boolean {
  if (c === null) return false
  if (now.chargesPaise > c.chargesPaise) return false
  if (now.outstandingPaise > c.outstandingPaise) return false
  return c.overrideReason !== null || c.outstandingPaise === 0
}
