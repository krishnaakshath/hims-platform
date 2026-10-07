// Pure (no 'use client'): importable from server and client components alike.
export interface DatedRateLike { validFrom: string; validTo: string | null; deactivated: boolean }

export type RateStatus = 'current' | 'scheduled' | 'ended' | 'deactivated'

/** Inclusive on both ends: a rate whose valid_to is today is still current. ISO dates compare lexicographically. */
export function rateStatus(r: DatedRateLike, today: string): RateStatus {
  if (r.deactivated) return 'deactivated'
  if (r.validTo !== null && r.validTo < today) return 'ended'
  if (r.validFrom > today) return 'scheduled'
  return 'current'
}

