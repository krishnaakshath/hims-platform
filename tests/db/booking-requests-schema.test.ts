import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { providers, bookingRequests } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdIds.pop()!))
})

describe('booking requests schema', () => {
  it('inserts a request with no provider preference and sane defaults', async () => {
    const db = getDb()
    const [row] = await db.insert(bookingRequests).values({
      requesterName: 'Jordan Rivera',
      requesterDob: '1990-05-14',
      requesterEmail: 'jordan@example.com',
      requesterPhone: null,
      preferredProviderId: null,
      preferredDateRangeStart: '2026-10-01',
      preferredDateRangeEnd: '2026-10-15',
      reason: 'New patient intake',
    }).returning()
    createdIds.push(row.id)

    expect(row.status).toBe('pending')
    expect(row.submittedAt).toBeTruthy()
    expect(row.reviewedByName).toBeNull()
    expect(row.reviewedAt).toBeNull()
    expect(row.declineReason).toBeNull()
    expect(row.resultingAppointmentId).toBeNull()
  })

  it('stores a preferredProviderId referencing a real provider', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [row] = await db.insert(bookingRequests).values({
      requesterName: 'Sam Lee',
      requesterDob: '1985-02-20',
      requesterEmail: null,
      requesterPhone: '555-0100',
      preferredProviderId: providerRow.id,
      preferredDateRangeStart: '2026-10-01',
      preferredDateRangeEnd: '2026-10-15',
      reason: 'Follow-up',
    }).returning()
    createdIds.push(row.id)
    expect(row.preferredProviderId).toBe(providerRow.id)
  })
})
