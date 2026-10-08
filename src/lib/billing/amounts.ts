// Pure, client-safe paise helpers. Unit prices stay int4-range (MAX_AMOUNT_PAISE); every
// computed amount and every sum is bigint-safe up to Number.MAX_SAFE_INTEGER.
export const MAX_LINE_QUANTITY = 1000
export const MAX_DOCUMENT_PAISE = 1_000_000_000_000
export const INT4_MAX = 2_147_483_647

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function isNonNegativeSafeInt(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0
}

function toSafeNumber(v: bigint, what: string): number {
  if (v > MAX_SAFE || v < -MAX_SAFE) throw new RangeError(`${what} is out of range`)
  return Number(v)
}

/** Taxable amount of a line: unit price × quantity, computed in BigInt. */
export function lineTaxablePaise(unitPricePaise: number, quantity: number): number {
  if (!isNonNegativeSafeInt(unitPricePaise)) throw new RangeError('Unit price must be a non-negative whole number of paise')
  if (!isNonNegativeSafeInt(quantity) || quantity === 0 || quantity > MAX_LINE_QUANTITY) {
    throw new RangeError(`Quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}`)
  }
  return toSafeNumber(BigInt(unitPricePaise) * BigInt(quantity), 'Line amount')
}

/** Exact sum of whole-paise values (BigInt accumulation). */
export function sumPaise(values: readonly number[]): number {
  let total = BigInt(0)
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError('Paise must be whole numbers')
    total += BigInt(v)
  }
  return toSafeNumber(total, 'Sum')
}

/** Reads a paise value as node-postgres returns it (bigint/numeric sums arrive as strings). null → 0. */
export function paiseFromDb(value: string | number | bigint | null): number {
  if (value === null) return 0
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('Paise must be a safe whole number')
    return value
  }
  if (typeof value === 'bigint') return toSafeNumber(value, 'Paise')
  if (!/^-?\d+$/.test(value)) throw new RangeError('Paise must be a whole number')
  return toSafeNumber(BigInt(value), 'Paise')
}
