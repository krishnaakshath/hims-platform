import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as submitBookingRequest } from '@/app/api/public/booking-requests/route'
import { getDb } from '@/db/client'
import { providers, bookingRequests } from '@/db/schema'
import { __resetBookingRequestGlobalBucketForTests } from '@/lib/rate-limit'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdIds.pop()!))
})

// This file's own success-path requests, plus the rate-limit test's 4
// submissions, all consume tokens from the flat, identity-independent
// 'global' booking-request bucket (see checkBookingRequestRateLimit in
// rate-limit.ts) -- the one bucket in the app shared across every caller,
// including tests/lib/rate-limit.test.ts's own deliberate saturation test.
// Reset unconditionally so a repeated full-suite run within the same 600s
// window can never leak a spurious 429 into this file's own `expect(...).
// toBe(201)` assertions, regardless of run order.
afterAll(async () => {
  await __resetBookingRequestGlobalBucketForTests()
})

function req(body: unknown, ip = '192.0.2.1') {
  return new Request('http://localhost/api/public/booking-requests', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  })
}

const validPayload = {
  requesterName: 'Taylor Morgan',
  requesterDob: '1988-03-12',
  requesterEmail: 'taylor@example.com',
  preferredDateRangeStart: '2026-11-01',
  preferredDateRangeEnd: '2026-11-15',
  reason: 'New patient intake',
}

describe('POST /api/public/booking-requests', () => {
  it('accepts a valid unauthenticated submission with no session', async () => {
    const res = await submitBookingRequest(req(validPayload, '192.0.2.10') as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdIds.push(body.id)
  })

  it('rejects extra fields via .strict()', async () => {
    const res = await submitBookingRequest(req({ ...validPayload, patientId: 'RD-0001' }, '192.0.2.11') as never)
    expect(res.status).toBe(400)
  })

  it('rejects a preferredProviderId that does not reference a real provider', async () => {
    const res = await submitBookingRequest(req({ ...validPayload, preferredProviderId: 999999999 }, '192.0.2.12') as never)
    expect(res.status).toBe(400)
  })

  it('stores only the spec-listed fields -- no extra PHI or request metadata persisted', async () => {
    const res = await submitBookingRequest(req(validPayload, '192.0.2.13') as never)
    const body = await res.json()
    createdIds.push(body.id)
    const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, body.id))
    expect(row.requesterName).toBe(validPayload.requesterName)
    expect(row.requesterPhone).toBeNull()
    expect(row.preferredProviderId).toBeNull()
    expect(row.status).toBe('pending')
    expect(row.reviewedByName).toBeNull()
    expect(row.reviewedAt).toBeNull()
    expect(row.declineReason).toBeNull()
    expect(row.resultingAppointmentId).toBeNull()
    expect(Object.keys(row).sort()).toEqual([
      'declineReason', 'id', 'preferredDateRangeEnd', 'preferredDateRangeStart', 'preferredProviderId',
      'reason', 'requesterDob', 'requesterEmail', 'requesterName', 'requesterPhone',
      'resultingAppointmentId', 'reviewedAt', 'reviewedByName', 'status', 'submittedAt',
    ].sort())
  })

  it('rejects an oversized reason field instead of accepting unbounded text from anonymous traffic', async () => {
    const res = await submitBookingRequest(req({ ...validPayload, reason: 'x'.repeat(3000) }, '192.0.2.14') as never)
    expect(res.status).toBe(400)
  })

  it('rejects a malformed requesterDob with 400, not an uncaught 500', async () => {
    const res = await submitBookingRequest(req({ ...validPayload, requesterDob: 'not-a-date' }, '192.0.2.15') as never)
    expect(res.status).toBe(400)
  })

  it('enforces the rate limit after enough requests from one IP', async () => {
    const ip = '192.0.2.20'
    let lastStatus = 0
    for (let i = 0; i < 4; i++) {
      const res = await submitBookingRequest(req({ ...validPayload, requesterEmail: `rl-${i}@example.com` }, ip) as never)
      lastStatus = res.status
      if (res.status === 201) createdIds.push((await res.json()).id)
    }
    expect(lastStatus).toBe(429)
  })
})
