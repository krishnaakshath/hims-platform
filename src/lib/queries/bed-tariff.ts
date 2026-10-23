// WS3 T4: the one place a bed's daily tariff is resolved for display -- the ROOM_RENT service
// (billing settings) priced by resolvePrice for the bed's room category and ward, and, when the stay
// has a payer, that payer's rate (payer > department > base). Shared by the admission dialog's bed
// list (no payer chosen yet) and the bed board's occupied-bed panel (the admission's payer).
import { resolvePrice } from '@/lib/tariff/resolve'
import { getBillingSettings } from './billing-settings'
import { loadPricingContext } from './tariff'

export interface BedTariffQuery { ward: string; roomCategoryCode: string | null; payerId?: number | null }

/** Loads the ROOM_RENT pricing once; the returned function gives paise per day, or null when unpriced. */
export async function loadBedTariffResolver(onDate: string): Promise<(q: BedTariffQuery) => number | null> {
  const serviceId = (await getBillingSettings()).roomRentServiceId
  if (serviceId === null) return () => null
  const pricing = await loadPricingContext(serviceId)
  return (q) => {
    const r = resolvePrice({ serviceId, payerId: q.payerId ?? undefined, roomCategory: q.roomCategoryCode ?? undefined, ward: q.ward, onDate }, pricing)
    return r.ok ? r.amountPaise : null
  }
}
