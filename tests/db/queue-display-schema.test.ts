import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, doctorAssignments, appSettings } from '@/db/schema'

const createdAssignmentIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
})

describe('queue display schema', () => {
  it('accepts a queueTicketNumber on a new doctorAssignments row', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [row] = await db.insert(doctorAssignments).values({
      patientId: patientRow.id, providerId: providerRow.id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Test', assignedByName: 'Test Staff', queueTicketNumber: 1,
    }).returning()
    createdAssignmentIds.push(row.id)
    expect(row.queueTicketNumber).toBe(1)
  })

  // The column is NOT NULL, but carries a DEFAULT 0 safety net so that
  // other branches/worktrees on this shared DB -- whose code doesn't know
  // about this column yet -- keep inserting successfully. Real ticket
  // numbers always come from this repo's own ticket-generation code
  // (Task 2), which never relies on the default.
  it('defaults queueTicketNumber to 0 when omitted, rather than rejecting the insert', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [row] = await db.insert(doctorAssignments).values({
      patientId: patientRow.id, providerId: providerRow.id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Test', assignedByName: 'Test Staff',
    } as never).returning()
    createdAssignmentIds.push(row.id)
    expect(row.queueTicketNumber).toBe(0)
  })

  it('rejects an insert with an explicit null queueTicketNumber (NOT NULL enforced)', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    await expect(db.insert(doctorAssignments).values({
      patientId: patientRow.id, providerId: providerRow.id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Test', assignedByName: 'Test Staff', queueTicketNumber: null,
    } as never)).rejects.toThrow()
  })

  it('reads a nullable queueDisplayPin off appSettings', async () => {
    const [row] = await getDb().select().from(appSettings)
    expect(row.queueDisplayPin === null || typeof row.queueDisplayPin === 'string').toBe(true)
  })
})
