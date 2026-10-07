/**
 * Pure tariff price resolver. No I/O: callers load the service and its candidate
 * rates (e.g. `loadPricingContext`) and pass them in.
 *
 * Precedence (spec, exact): the scope decides first — payer > department > base.
 * Room-category/ward specificity only ranks rates inside the winning scope.
 * Date ranges are inclusive on both ends; a null `validTo` is open-ended.
 * Money is integer paise.
 */

import { isoDate } from './validation'

export type TariffScope = 'base' | 'department' | 'payer'

export interface ServiceForPricing {
  id: number
  code: string
  name: string
  departmentId: number
  isActive: boolean
  hsnSac: string
  gstRateBp: number
}

export interface TariffRateCandidate {
  id: number
  serviceId: number
  scope: TariffScope
  departmentId: number | null
  payerId: number | null
  roomCategoryCode: string | null
  ward: string | null
  amountPaise: number
  validFrom: string
  validTo: string | null
  deactivated: boolean
}

export interface PriceQuery {
  serviceId: number
  payerId?: number
  /** Ordering department; defaults to the service's own department. */
  departmentId?: number
  /** Room category code. */
  roomCategory?: string
  ward?: string
  /** ISO `YYYY-MM-DD`. */
  onDate: string
}

export type PriceResolution =
  | {
      ok: true
      serviceId: number
      serviceCode: string
      serviceName: string
      amountPaise: number
      currency: 'INR'
      gstRateBp: number
      hsnSac: string
      rateId: number
      scope: TariffScope
      matched: { roomCategory: boolean; ward: boolean }
    }
  | { ok: false; reason: 'invalid_date' | 'service_not_found' | 'service_inactive' | 'no_rate' }

/** Trim, collapse internal whitespace, lower-case. */
export function normalizeWard(ward: string): string {
  return ward.trim().replace(/\s+/g, ' ').toLowerCase()
}

const normalizeCategory = (c: string) => c.trim().toLowerCase()

interface Ranked {
  rate: TariffRateCandidate
  matched: { roomCategory: boolean; ward: boolean }
  specificity: number
}

/** True when `a` should win over `b` inside the same scope. */
function beats(a: Ranked, b: Ranked): boolean {
  if (a.specificity !== b.specificity) return a.specificity > b.specificity
  if (a.rate.validFrom !== b.rate.validFrom) return a.rate.validFrom > b.rate.validFrom
  return a.rate.id > b.rate.id
}

export function resolvePrice(
  query: PriceQuery,
  ctx: { service: ServiceForPricing | null; rates: TariffRateCandidate[] },
): PriceResolution {
  const { onDate } = query
  if (typeof onDate !== 'string' || !isoDate.safeParse(onDate).success) return { ok: false, reason: 'invalid_date' }
  const service = ctx.service
  if (!service) return { ok: false, reason: 'service_not_found' }
  if (!service.isActive) return { ok: false, reason: 'service_inactive' }

  const effectiveDepartment = query.departmentId ?? service.departmentId
  const queryCategory = query.roomCategory != null ? normalizeCategory(query.roomCategory) : null
  const queryWard = query.ward != null ? normalizeWard(query.ward) : null

  const tierOf = (r: TariffRateCandidate): number | null => {
    if (r.scope === 'payer') return query.payerId != null && r.payerId === query.payerId ? 0 : null
    if (r.scope === 'department') return r.departmentId === effectiveDepartment ? 1 : null
    if (r.scope === 'base') return 2
    return null
  }

  const best: (Ranked | null)[] = [null, null, null]
  for (const r of ctx.rates) {
    if (r.serviceId !== query.serviceId || r.deactivated) continue
    if (r.validFrom > onDate) continue
    if (r.validTo !== null && onDate > r.validTo) continue

    const categoryHit = r.roomCategoryCode !== null
    if (categoryHit && (queryCategory === null || normalizeCategory(r.roomCategoryCode!) !== queryCategory)) continue
    const wardHit = r.ward !== null
    if (wardHit && (queryWard === null || normalizeWard(r.ward!) !== queryWard)) continue

    const tier = tierOf(r)
    if (tier === null) continue

    const candidate: Ranked = {
      rate: r,
      matched: { roomCategory: categoryHit, ward: wardHit },
      specificity: (wardHit ? 2 : 0) + (categoryHit ? 1 : 0),
    }
    const current = best[tier]
    if (!current || beats(candidate, current)) best[tier] = candidate
  }

  const winner = best.find((b): b is Ranked => b !== null)
  if (!winner) return { ok: false, reason: 'no_rate' }

  return {
    ok: true,
    serviceId: service.id,
    serviceCode: service.code,
    serviceName: service.name,
    amountPaise: winner.rate.amountPaise,
    currency: 'INR',
    gstRateBp: service.gstRateBp,
    hsnSac: service.hsnSac,
    rateId: winner.rate.id,
    scope: winner.rate.scope,
    matched: winner.matched,
  }
}
