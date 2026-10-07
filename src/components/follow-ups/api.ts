// Client fetch helpers for the follow-up and encounter routes. Every mutation
// goes through the server routes; the server's own error text is surfaced.
import type { BookFollowUpRequest, ContactAttemptRequest, CreateFollowUpRequest, UpdateFollowUpPlanRequest } from '@/lib/follow-ups/validation'
import { followUpVisitReason } from '@/lib/follow-ups/rules'

export type ApiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

const UNREACHABLE = 'Could not reach the server. Please try again.'
const GENERIC = 'Something went wrong. Please try again.'

async function call<T>(url: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => null)
    if (res.ok) return { ok: true, data: data as T }
    const error = data && typeof data.error === 'string' && data.error ? data.error : GENERIC
    return { ok: false, error }
  } catch {
    return { ok: false, error: UNREACHABLE }
  }
}

export const createFollowUp = (body: CreateFollowUpRequest) => call<{ order: unknown }>('/api/follow-ups', 'POST', body)
export const updateFollowUp = (id: number, body: UpdateFollowUpPlanRequest) =>
  call<{ order: unknown; bookingOutsideWindow?: boolean }>(`/api/follow-ups/${id}`, 'PATCH', body)
export const cancelFollowUp = (id: number, reason: string) => call<{ order: unknown }>(`/api/follow-ups/${id}/cancel`, 'POST', { reason })
export const bookFollowUpSlot = (id: number, body: BookFollowUpRequest) => call<{ order: unknown }>(`/api/follow-ups/${id}/booking`, 'PUT', body)
export const unbookFollowUpSlot = (id: number, reason: string) => call<{ order: unknown }>(`/api/follow-ups/${id}/unbook`, 'POST', { reason })
export const logContactAttempt = (id: number, body: ContactAttemptRequest) => call<{ attempt: unknown }>(`/api/follow-ups/${id}/contact-attempts`, 'POST', body)
export const changeEncounterStatus = (id: number, body: { to: 'in_consultation' | 'completed' | 'cancelled'; cancelReason?: string }) =>
  call<{ encounter: unknown }>(`/api/encounters/${id}/status`, 'POST', body)
export const checkInForAppointment = (body: { patientId: string; providerId: number; appointmentId: number; reason: string }) =>
  call<unknown>('/api/front-desk/check-in', 'POST', { ...body, visitType: 'outpatient', urgency: 'routine' })

/** The visit reason a follow-up check-in carries ("Follow-up: …", capped). */
export { followUpVisitReason }
