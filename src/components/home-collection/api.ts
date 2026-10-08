// SP5: client helpers for the home-collection routes. Types only from the query module (erased at
// build), so nothing server-side is bundled. Every helper returns the server's fixed error text.
import { fetchJson } from '@/lib/client-fetch'
import type { HomeCollectionContext, WindowAvailability } from '@/lib/queries/home-collections'
import type { BookHomeCollectionRequest } from '@/lib/labs/validation'
import type { RescheduleReason, VisitCancelReason } from '@/lib/home-collection/rules'

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

// Shared client fetch helper (src/lib/client-fetch.ts): the route's own 400/404/409/422 text is
// shown, every other failure (401/403/5xx/network) a fixed message; never server internals.
async function call<T>(url: string, init: RequestInit | undefined): Promise<ApiResult<T>> {
  const res = await fetchJson<T>(url, init)
  return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function fetchBookingContext(patient: string) {
  return call<HomeCollectionContext>(`/api/home-collections/context?patient=${encodeURIComponent(patient)}`, undefined)
}

export function fetchAvailability(dateIso: string) {
  return call<WindowAvailability[]>(`/api/home-collections/availability?date=${encodeURIComponent(dateIso)}`, undefined)
}

export function bookVisit(body: BookHomeCollectionRequest) {
  return call<{ visit: { id: number }; sampleIds: Record<string, string> }>('/api/home-collections', json('POST', body))
}

export function rescheduleVisit(visitId: number, body: { visitDate: string; windowId: number; reason: RescheduleReason; note?: string }) {
  return call<{ visit: { id: number } }>(`/api/home-collections/${visitId}`, json('PATCH', body))
}

export function cancelVisit(visitId: number, body: { reason: VisitCancelReason; note?: string }) {
  return call<{ ok: true; releasedOrderIds: number[] }>(`/api/home-collections/${visitId}/cancel`, json('POST', body))
}

export function assignVisitCollector(visitId: number, collectorUserId: number | null) {
  return call<{ visit: { id: number; collectorUserId: number | null } }>(`/api/home-collections/${visitId}/collector`, json('PUT', { collectorUserId }))
}

/** `/lab-labels` link for a set of order ids (the label sheet caps and validates them again). */
export function labelsHref(orderIds: number[]): string {
  return `/lab-labels?orders=${orderIds.join(',')}`
}

// SP5 Task 12: the collector marks a visit collected by the sample IDs of the tubes drawn.
export function collectVisit(visitId: number, sampleIds: string[]) {
  return call<{ ok: true; collectedOrderIds: number[]; notCollectedOrderIds: number[]; encounterId: number }>(
    `/api/home-collections/${visitId}/collect`, json('POST', { sampleIds }),
  )
}
