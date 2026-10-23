// Foundations T11: what is still owed on one invoice. Pure, so pages and queries share it.
import { sumPaise } from './amounts'

/** Finalised: total less receipts against it (floor 0). Cancelled: 0 (the credit note closed it). Draft/discarded: null. */
export function invoiceOutstandingPaise(status: string, totalPaise: number | null, paidPaise: number): number | null {
  if (status === 'cancelled') return 0
  if (status !== 'finalised' || totalPaise == null) return null
  return Math.max(0, sumPaise([totalPaise, -paidPaise]))
}
