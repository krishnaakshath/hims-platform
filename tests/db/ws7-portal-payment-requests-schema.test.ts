// WS7 T8 (spec D14): payment_requests.source, reported_utr, reported_at.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, paymentRequests } from '@/db/schema'
import { readMigration, idempotencyProblems } from './migration-sql'

const MIGRATION = '2026-10-26-ws7-portal-payment-requests.sql'
const PID = `WS7-PPR-${process.pid}`
const base = { patientId: PID, amountPaise: 100, vpa: 'a@ybl', note: 'n', createdBy: 'test' }

beforeAll(async () => { await getDb().insert(patients).values({ id: PID, name: 'Portal Pay Schema', dob: '1980-01-01' }) })
afterAll(async () => {
  await getDb().delete(paymentRequests).where(eq(paymentRequests.patientId, PID))
  await getDb().delete(patients).where(eq(patients.id, PID))
})

describe('WS7 T8 portal payment request columns', () => {
  it('the migration is idempotent, sorts after the table it alters and declares the columns and check', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(MIGRATION > '2026-10-23-payment-requests.sql').toBe(true)
    for (const n of ['source', 'reported_utr', 'reported_at', 'payment_requests_source_valid']) expect(s).toContain(n)
  })

  it("a request defaults to source 'staff' and an unknown source is refused", async () => {
    const [row] = await getDb().insert(paymentRequests).values(base).returning()
    expect(row).toMatchObject({ source: 'staff', reportedUtr: null, reportedAt: null })
    await expect(getDb().insert(paymentRequests).values({ ...base, source: 'kiosk' })).rejects.toThrow()
  })
})
