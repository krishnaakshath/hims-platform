import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { messages, patientTrialScreenings } from '@/db/schema'

const PATIENT_ID = 'RD-0003'
let original: typeof patientTrialScreenings.$inferSelect
const createdMessageIds: number[] = []

beforeEach(async () => {
  ;[original] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, PATIENT_ID))
})
afterEach(async () => {
  await getDb().update(patientTrialScreenings).set({
    overallStatus: original.overallStatus,
    selectionConfirmedAt: original.selectionConfirmedAt,
    selectionConfirmedByName: original.selectionConfirmedByName,
    selectionNotifiedAt: original.selectionNotifiedAt,
  }).where(eq(patientTrialScreenings.id, original.id))
  if (createdMessageIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdMessageIds))
    createdMessageIds.length = 0
  }
})

describe('eligibility auto-notification schema', () => {
  it('defaults all three selection columns to null on an existing screening', async () => {
    expect(original.selectionConfirmedAt).toBeNull()
    expect(original.selectionConfirmedByName).toBeNull()
    expect(original.selectionNotifiedAt).toBeNull()
  })

  it('stores and reads back the three selection columns', async () => {
    const now = new Date()
    const [updated] = await getDb().update(patientTrialScreenings)
      .set({ selectionConfirmedAt: now, selectionConfirmedByName: 'Dr. Rajiv Kunam', selectionNotifiedAt: now })
      .where(eq(patientTrialScreenings.id, original.id))
      .returning()
    expect(updated.selectionConfirmedByName).toBe('Dr. Rajiv Kunam')
    expect(updated.selectionConfirmedAt).toBeInstanceOf(Date)
    expect(updated.selectionNotifiedAt).toBeInstanceOf(Date)
  })

  it('accepts a system-sender message row', async () => {
    const [row] = await getDb().insert(messages).values({
      patientId: PATIENT_ID,
      senderRole: 'system',
      senderName: 'HIMS (Automated)',
      body: 'schema probe',
    }).returning()
    createdMessageIds.push(row.id)
    expect(row.senderRole).toBe('system')
  })
})
