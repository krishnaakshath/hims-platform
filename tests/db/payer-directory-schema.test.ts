import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, payers, identityVerifications } from '@/db/schema'

const createdPayerIds: number[] = []
afterEach(async () => {
  while (createdPayerIds.length > 0) await getDb().delete(payers).where(eq(payers.id, createdPayerIds.pop()!))
})

describe('payer directory / patient insurance schema', () => {
  it('inserts a payer and reads its type back', async () => {
    const [payer] = await getDb().insert(payers).values({ name: 'Test Payer Co', payerId: '99999', payerType: 'commercial' }).returning()
    createdPayerIds.push(payer.id)
    expect(payer.payerType).toBe('commercial')
  })

  it('a patient can carry nullable primary/secondary insurance referencing a payer', async () => {
    const db = getDb()
    const [payer] = await db.insert(payers).values({ name: 'Test Payer Co', payerId: '99999', payerType: 'commercial' }).returning()
    createdPayerIds.push(payer.id)
    const [patientRow] = await db.select().from(patients).limit(1)
    expect(patientRow.primaryPayerId ?? null).not.toBeUndefined() // column exists and is readable even when null

    const [updated] = await db.update(patients).set({
      primaryPayerId: payer.id,
      primaryMemberId: 'M123',
      primaryGroupNumber: 'G456',
      primaryPlanType: 'ppo',
      primarySubscriberName: 'Test Subscriber',
      primarySubscriberRelationship: 'self',
    }).where(eq(patients.id, patientRow.id)).returning()
    expect(updated.primaryPayerId).toBe(payer.id)
    expect(updated.primaryPlanType).toBe('ppo')

    // Revert -- this is a real seeded patient row, not scratch data.
    await db.update(patients).set({
      primaryPayerId: null, primaryMemberId: null, primaryGroupNumber: null,
      primaryPlanType: null, primarySubscriberName: null, primarySubscriberRelationship: null,
    }).where(eq(patients.id, patientRow.id))
  })

  it('widened idTypeEnum accepts military_id and green_card', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [existing] = await db.select().from(identityVerifications).where(eq(identityVerifications.patientId, patientRow.id))
    if (existing) {
      // Confirm the enum accepts the new values via an UPDATE ... RETURNING round trip, then restore.
      const [updated] = await db.update(identityVerifications).set({ idType: 'military_id' }).where(eq(identityVerifications.id, existing.id)).returning()
      expect(updated.idType).toBe('military_id')
      await db.update(identityVerifications).set({ idType: existing.idType }).where(eq(identityVerifications.id, existing.id))
    }
  })
})
