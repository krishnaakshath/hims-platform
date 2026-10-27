// WS2 T8 (spec ruling 7): pure, client-safe pharmacy price model. A medicine carries a GST-inclusive
// MRP per dispensing unit; the charge line's unit price is the taxable value backed out of it.
// Selling above MRP is unlawful, so the unit price is the largest whole-paise value whose line
// total (taxable + GST, half-up per line, under EITHER intra- or inter-state supply) stays within
// MRP × quantity. The shortfall is less than one unit step (q × (1 + rate)) plus 2 paise of rounding.
import { z } from 'zod'
import { MAX_LINE_QUANTITY } from '@/lib/billing/amounts'
import { lineTax } from '@/lib/billing/gst'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'

const MAX_MRP_PAISE = 1_000_000_000

export interface PharmacyLinePrice { unitPricePaise: number; taxablePaise: number; gstPaise: number; totalPaise: number }

/** The worse (higher) of the intra- and inter-state line totals of a taxable value. */
function worstTotalPaise(taxablePaise: number, gstRateBp: number): number {
  return Math.max(lineTax(taxablePaise, gstRateBp, 'intra').totalPaise, lineTax(taxablePaise, gstRateBp, 'inter').totalPaise)
}

export function pharmacyLinePrice(i: { mrpPerUnitPaise: number; quantity: number; gstRateBp: number }): PharmacyLinePrice {
  const { mrpPerUnitPaise: mrp, quantity: q, gstRateBp: r } = i
  if (!Number.isSafeInteger(mrp) || mrp < 0 || mrp > MAX_MRP_PAISE) throw new RangeError('MRP must be a whole number of paise from 0 to 1,000,000,000')
  if (!Number.isSafeInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) throw new RangeError(`Quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}`)
  const cap = mrp * q // <= 1e12, exact in a double
  // Start at the exact back-out and correct for per-line rounding (lineTax validates the rate).
  let u = Math.floor((mrp * 10000) / (10000 + r))
  while (u > 0 && worstTotalPaise(u * q, r) > cap) u--
  while (worstTotalPaise((u + 1) * q, r) <= cap) u++
  const taxablePaise = u * q
  const totalPaise = worstTotalPaise(taxablePaise, r)
  return { unitPricePaise: u, taxablePaise, gstPaise: totalPaise - taxablePaise, totalPaise }
}

export const EXPIRY_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/** A 'YYYY-MM' expiry month is expired when it is earlier than the current IST month. */
export function isExpiredMonth(expiryMonth: string, now: Date = new Date()): boolean {
  return expiryMonth < todayIsoIn(DEFAULT_TIMEZONE, now).slice(0, 7)
}

/** 'YYYY-MM' → 'MM/YYYY', as printed on the strip and the bill. */
export function expiryLabel(expiryMonth: string): string {
  return `${expiryMonth.slice(5, 7)}/${expiryMonth.slice(0, 4)}`
}

export const medicationPriceSchema = z.object({
  mrpPerUnitPaise: z.number().int().min(0).max(MAX_MRP_PAISE),
  gstRateBp: z.union([z.literal(0), z.literal(500), z.literal(1200), z.literal(1800), z.literal(2800), z.literal(4000)]).nullable().optional(),
  hsn: z.string().regex(/^\d{4,8}$/).nullable().optional(),
}).strict()
export type MedicationPriceInput = z.infer<typeof medicationPriceSchema>
