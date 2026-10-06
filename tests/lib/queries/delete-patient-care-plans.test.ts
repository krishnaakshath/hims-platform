import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'
import { deletePatient } from '@/lib/queries/patients'
import { createCarePlan } from '@/lib/queries/care-plans'

describe('deletePatient — care plans cleanup', () => {
  // Regression test for the final whole-branch review's Critical finding:
  // care_plans.patient_id is a NOT NULL FK to patients(id) with no ON DELETE
  // action (Task 1 of feature/care-plans), and deletePatient() was never
  // updated for it -- deleting a patient with a care plan deleted their
  // whole chart in this function's non-transactional cascade, then failed on
  // the final `DELETE FROM patients` with a foreign-key violation, leaving a
  // half-deleted patient with orphaned care_plans/care_plan_goals rows.
  //
  // Matches the shape of tests/lib/queries/delete-patient-admissions.test.ts
  // (a dedicated TEST-*-${Date.now()} patient, not a random existing one --
  // this function makes ~20+ real sequential round trips, so the same
  // per-test timeout override applies).
  it('deletes care plans and their goals for the patient, and does not leave an FK violation', { timeout: 30000 }, async () => {
    const db = getDb()
    const testPatientId = `TEST-DEL-CP-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, name: 'Delete Care Plan Test Patient', dob: '2000-01-01' })

    const plan = await createCarePlan({
      patientId: testPatientId,
      title: 'Test Plan',
      authorName: 'Dr. Test',
      nextReviewDate: null,
      goals: [{ description: 'Attend weekly CBT', targetDate: null }],
    })

    const deleted = await deletePatient(testPatientId)
    expect(deleted).toBe(true)

    const remainingPlans = await db.select().from(carePlans).where(eq(carePlans.patientId, testPatientId))
    expect(remainingPlans.length).toBe(0)
    const remainingGoals = await db.select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))
    expect(remainingGoals.length).toBe(0)
  })
})
