// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, payers, patientPolicies, providers, appointments } from '@/db/schema'
import { listPatientsWithStatus } from '@/lib/queries/patients'

// lastVisitAt / primaryPayerName on the list row (hospital patient list).
const WITH = 'RD-T3-WITH'
const WITHOUT = 'RD-T3-NONE'
let payerId = 0
let providerId = 0

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values([{ id: WITH, name: 'T3 With', dob: '1990-01-01' }, { id: WITHOUT, name: 'T3 Without', dob: '1990-01-01' }])
  const [p] = await db.insert(payers).values({ name: 'T3 Star Health', payerId: `T3-${Date.now()}` }).returning()
  payerId = p.id
  const [pr] = await db.insert(providers).values({ name: 'T3 Dr', specialty: 'Test', colorTag: '#000000' }).returning()
  providerId = pr.id
  await db.insert(patientPolicies).values({
    patientId: WITH, insurerPayerId: payerId, policyNumber: 'P1', memberId: 'M1', policyType: 'individual', holderName: 'T3 With',
    relationship: 'self', validFrom: '2026-01-01', validTo: '2027-01-01', createdByName: 'test',
  })
  await db.insert(appointments).values([
    { patientId: WITH, providerId, startsAt: new Date('2026-03-01T04:00:00Z'), endsAt: new Date('2026-03-01T04:30:00Z'), visitReason: 'Test' },
    { patientId: WITH, providerId, startsAt: new Date('2026-04-01T04:00:00Z'), endsAt: new Date('2026-04-01T04:30:00Z'), visitReason: 'Test' },
    { patientId: WITH, providerId, startsAt: new Date('2099-01-01T04:00:00Z'), endsAt: new Date('2099-01-01T04:30:00Z'), visitReason: 'Test' },
  ])
})

afterAll(async () => {
  const db = getDb()
  await db.delete(appointments).where(eq(appointments.patientId, WITH))
  await db.delete(patientPolicies).where(eq(patientPolicies.patientId, WITH))
  await db.delete(patients).where(inArray(patients.id, [WITH, WITHOUT]))
  await db.delete(payers).where(eq(payers.id, payerId))
  await db.delete(providers).where(eq(providers.id, providerId))
})

describe('listPatientsWithStatus hospital columns', () => {
  it('derives the latest past visit and the primary payer, and nulls when absent', async () => {
    const rows = await listPatientsWithStatus(null)
    const a = rows.find((r) => r.id === WITH)!
    const b = rows.find((r) => r.id === WITHOUT)!
    expect(a.primaryPayerName).toBe('T3 Star Health')
    expect(new Date(a.lastVisitAt!).toISOString()).toBe('2026-04-01T04:00:00.000Z')
    expect(b.primaryPayerName).toBeNull()
    expect(b.lastVisitAt).toBeNull()
  })
})
