// SP4: display labels shared by the billing screens (client-safe, no I/O).
export const PRICE_SOURCE_LABELS: Record<string, string> = {
  base: 'Base rate', department: 'Department rate', payer: 'Payer rate', manual: 'Manual', pharmacy: 'Pharmacy',
}

export const LINE_STATUS_LABELS: Record<string, string> = { captured: 'Captured', invoiced: 'Invoiced', void: 'Void' }

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', finalised: 'Finalised', cancelled: 'Cancelled', discarded: 'Discarded',
}

export const PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT / bank transfer', other: 'Other',
}

/** Basis points to a percent string: 1800 -> '18%', 250 -> '2.5%'. */
export function bpToPercent(bp: number): string {
  return `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(bp % 10 === 0 ? 1 : 2)}%`
}
