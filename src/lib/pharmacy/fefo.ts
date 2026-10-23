// FEFO (first expiry, first out) allocation over a drug's batches (spec D2).
// Pure: no DB, no clock. Dates are IST business dates as 'YYYY-MM-DD' strings,
// so plain string comparison orders them.

export interface BatchStock {
  id: number
  batchNo: string
  expiryDate: string | null
  quantityOnHand: number
  mrpPerUnitPaise: number
  writtenOff: boolean
}

export type FefoResult =
  | { ok: true; allocations: { batchId: number; quantity: number }[] }
  | { ok: false; error: 'insufficient_stock' | 'only_expired_stock' }

/** Expired means the expiry date is before today; a batch expiring today is still usable. */
export function isExpired(b: Pick<BatchStock, 'expiryDate'>, todayIso: string): boolean {
  return b.expiryDate !== null && b.expiryDate < todayIso
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Not yet expired and expiring on or before today + days. */
export function expiresWithinDays(b: Pick<BatchStock, 'expiryDate'>, todayIso: string, days: number): boolean {
  if (b.expiryDate === null || isExpired(b, todayIso)) return false
  return b.expiryDate <= addDaysIso(todayIso, days)
}

/** 'YYYY-MM' (the WS2 charge snapshot format), or null for a batch with no expiry. */
export function expiryMonth(expiryDate: string | null): string | null {
  return expiryDate === null ? null : expiryDate.slice(0, 7)
}

function fefoOrder(a: BatchStock, b: BatchStock): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1
    if (b.expiryDate === null) return -1
    return a.expiryDate < b.expiryDate ? -1 : 1
  }
  return a.id - b.id
}

export function pickFefo(batches: BatchStock[], quantity: number, todayIso: string): FefoResult {
  const live = batches.filter((b) => !b.writtenOff && b.quantityOnHand > 0)
  const usable = live.filter((b) => !isExpired(b, todayIso)).sort(fefoOrder)
  const usableTotal = usable.reduce((s, b) => s + b.quantityOnHand, 0)
  if (usableTotal < quantity) {
    const total = live.reduce((s, b) => s + b.quantityOnHand, 0)
    return { ok: false, error: total >= quantity ? 'only_expired_stock' : 'insufficient_stock' }
  }
  const allocations: { batchId: number; quantity: number }[] = []
  let remaining = quantity
  for (const b of usable) {
    if (remaining <= 0) break
    const take = Math.min(b.quantityOnHand, remaining)
    allocations.push({ batchId: b.id, quantity: take })
    remaining -= take
  }
  return { ok: true, allocations }
}
