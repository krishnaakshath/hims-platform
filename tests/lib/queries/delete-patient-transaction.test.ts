import { describe, it, expect, vi, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, carePlanGoals, carePlans, patientContacts, patients } from '@/db/schema'
import { createCarePlan } from '@/lib/queries/care-plans'

// Wave H P2-06: deletePatient() is ONE transaction. A failure part-way (here:
// the audit insert, which now runs inside the same transaction) rolls back
// every delete -- no half-deleted chart -- and on success the audit row
// commits with the delete.
const failAudit = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit')
  return {
    ...actual,
    logAudit: vi.fn(async (...args: Parameters<typeof actual.logAudit>) => {
      if (failAudit.on) throw new Error('probe audit failure')
      return actual.logAudit(...args)
    }),
  }
})

import { deletePatient } from '@/lib/queries/patients'

const stamp = Date.now()
const PROBE_USER = `TEST_WH_DEL_AUDIT_${stamp}`
const created: string[] = []

afterAll(async () => {
  const db = getDb()
  failAudit.on = false
  for (const id of created) {
    const [still] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))
    if (still) await deletePatient(id)
  }
  await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
})

async function seedPatient(suffix: string) {
  const id = `TEST_WH_DEL_${suffix}_${stamp}`
  created.push(id)
  const db = getDb()
  await db.insert(patients).values({ id, name: 'Wave H Delete Probe', dob: '2000-01-01' })
  await db.insert(patientContacts).values({ patientId: id, kind: 'emergency', name: 'Probe Contact', relationship: 'other', phone: '+919999999999' })
  const plan = await createCarePlan({ patientId: id, title: 'Probe plan', authorName: 'Dr. Probe', nextReviewDate: null, goals: [{ description: 'Probe goal', targetDate: null }] })
  return { id, planId: plan.id }
}

const session = { role: 'admin' as const, name: PROBE_USER, userId: null }

describe('deletePatient — single transaction', () => {
  it('rolls back every delete when a later step fails', { timeout: 30000 }, async () => {
    const { id, planId } = await seedPatient('RB')
    failAudit.on = true
    await expect(deletePatient(id, { session })).rejects.toThrow('probe audit failure')
    failAudit.on = false

    const db = getDb()
    expect(await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))).toHaveLength(1)
    expect(await db.select({ id: patientContacts.id }).from(patientContacts).where(eq(patientContacts.patientId, id))).toHaveLength(1)
    expect(await db.select({ id: carePlans.id }).from(carePlans).where(eq(carePlans.patientId, id))).toHaveLength(1)
    expect(await db.select({ id: carePlanGoals.id }).from(carePlanGoals).where(eq(carePlanGoals.carePlanId, planId))).toHaveLength(1)
  })

  it('deletes the chart and commits the audit row with it', { timeout: 30000 }, async () => {
    const { id } = await seedPatient('OK')
    expect(await deletePatient(id, { session })).toBe(true)

    const db = getDb()
    expect(await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id))).toHaveLength(0)
    expect(await db.select({ id: patientContacts.id }).from(patientContacts).where(eq(patientContacts.patientId, id))).toHaveLength(0)
    const audit = await db.select({ action: auditLog.action, patientId: auditLog.patientId }).from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audit).toEqual([{ action: 'deleted patient record', patientId: id }])
  })

  it('returns false (and writes no audit row) for an unknown patient', async () => {
    expect(await deletePatient(`TEST_WH_DEL_NONE_${stamp}`, { session })).toBe(false)
    const audit = await getDb().select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.patientId, `TEST_WH_DEL_NONE_${stamp}`))
    expect(audit).toHaveLength(0)
  })
})
