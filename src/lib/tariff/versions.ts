// Pure helpers for effective-dated tariff rates: overlap detection and revision planning.
// Dates are ISO YYYY-MM-DD strings (lexicographic order == chronological order); ranges are
// inclusive on both ends and a null validTo is open-ended.
import type { TARIFF_SCOPES } from '@/db/schema'

export type TariffScope = (typeof TARIFF_SCOPES)[number]

// One definition of ward normalisation (resolver and version helpers must agree).
import { normalizeWard } from './resolve'
export { normalizeWard }

export interface RateDims {
  serviceId: number; scope: TariffScope
  departmentId: number | null; payerId: number | null; roomCategoryId: number | null; ward: string | null
}
export interface DatedRate extends RateDims { id?: number; validFrom: string; validTo: string | null; deactivated?: boolean }

export function sameDims(a: RateDims, b: RateDims): boolean {
  const wardA = a.ward === null ? null : normalizeWard(a.ward)
  const wardB = b.ward === null ? null : normalizeWard(b.ward)
  return a.serviceId === b.serviceId && a.scope === b.scope && a.departmentId === b.departmentId
    && a.payerId === b.payerId && a.roomCategoryId === b.roomCategoryId && wardA === wardB
}

export function rangesOverlap(a: Pick<DatedRate, 'validFrom' | 'validTo'>, b: Pick<DatedRate, 'validFrom' | 'validTo'>): boolean {
  const aStartsBeforeBEnds = b.validTo === null || a.validFrom <= b.validTo
  const bStartsBeforeAEnds = a.validTo === null || b.validFrom <= a.validTo
  return aStartsBeforeBEnds && bStartsBeforeAEnds
}

/** First active existing rate with the same dimensions and an overlapping range, ignoring the candidate itself. */
export function findOverlap(candidate: DatedRate, existing: DatedRate[]): DatedRate | null {
  for (const e of existing) {
    if (e.deactivated) continue
    if (candidate.id !== undefined && e.id === candidate.id) continue
    if (sameDims(candidate, e) && rangesOverlap(candidate, e)) return e
  }
  return null
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export type RevisionPlan =
  | { ok: true; close: { id: number; validTo: string }; insert: DatedRate & { amountPaise: number } }
  | { ok: false; error: string }

export function planRevision(
  current: DatedRate & { id: number; amountPaise: number; deactivated: boolean },
  input: { amountPaise: number; effectiveFrom: string },
): RevisionPlan {
  if (current.deactivated) return { ok: false, error: 'The rate is deactivated' }
  if (input.effectiveFrom <= current.validFrom) return { ok: false, error: 'New rate must start after the current rate starts' }
  if (current.validTo !== null && input.effectiveFrom > current.validTo) {
    return { ok: false, error: 'The current rate ends before that date; add a new rate instead' }
  }
  if (input.amountPaise === current.amountPaise) return { ok: false, error: 'The new amount equals the current amount' }
  return {
    ok: true,
    close: { id: current.id, validTo: addDays(input.effectiveFrom, -1) },
    insert: {
      serviceId: current.serviceId, scope: current.scope, departmentId: current.departmentId, payerId: current.payerId,
      roomCategoryId: current.roomCategoryId, ward: current.ward,
      validFrom: input.effectiveFrom, validTo: current.validTo, amountPaise: input.amountPaise,
    },
  }
}
