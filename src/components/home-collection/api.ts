// SP5: client helpers for the home-collection routes. Types only from the query module (erased at
// build), so nothing server-side is bundled. Every helper returns the server's fixed error text.
import type { HomeCollectionContext, WindowAvailability } from '@/lib/queries/home-collections'
import type { BookHomeCollectionRequest } from '@/lib/labs/validation'
import type { RescheduleReason, VisitCancelReason } from '@/lib/home-collection/rules'

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { ok: false, error: 'Could not reach the server. Check the connection and try again.' }
  }
  const body = await res.json().catch(() => null)
  if (res.ok) return { ok: true, data: body as T }
  const error = body && typeof body.error === 'string' ? body.error : fallback
  return { ok: false, error }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function fetchBookingContext(patient: string) {
  return call<HomeCollectionContext>(`/api/home-collections/context?patient=${encodeURIComponent(patient)}`, undefined, 'Could not find that patient.')
}

export function fetchAvailability(dateIso: string) {
  return call<WindowAvailability[]>(`/api/home-collections/availability?date=${encodeURIComponent(dateIso)}`, undefined, 'Could not load the collection windows.')
}

export function bookVisit(body: BookHomeCollectionRequest) {
  return call<{ visit: { id: number }; sampleIds: Record<string, string> }>('/api/home-collections', json('POST', body), 'Could not book the home collection.')
}

export function rescheduleVisit(visitId: number, body: { visitDate: string; windowId: number; reason: RescheduleReason; note?: string }) {
  return call<{ visit: { id: number } }>(`/api/home-collections/${visitId}`, json('PATCH', body), 'Could not reschedule the visit.')
}

export function cancelVisit(visitId: number, body: { reason: VisitCancelReason; note?: string }) {
  return call<{ ok: true; releasedOrderIds: number[] }>(`/api/home-collections/${visitId}/cancel`, json('POST', body), 'Could not cancel the visit.')
}

export function assignVisitCollector(visitId: number, collectorUserId: number | null) {
  return call<{ visit: { id: number; collectorUserId: number | null } }>(`/api/home-collections/${visitId}/collector`, json('PUT', { collectorUserId }), 'Could not assign the collector.')
}

/** `/lab-labels` link for a set of order ids (the label sheet caps and validates them again). */
export function labelsHref(orderIds: number[]): string {
  return `/lab-labels?orders=${orderIds.join(',')}`
}
