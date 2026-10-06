import { describe, it, expect, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'
import { createCarePlan, listCarePlansForPatient, updateGoalStatus } from '@/lib/queries/care-plans'

const createdPlanIds: number[] = []
afterEach(async () => {
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

describe('createCarePlan', () => {
  it('creates a plan with goals, all defaulting to active', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await createCarePlan({
      patientId: patientRow.id, title: 'Initial Plan', authorName: 'Dr. Test', nextReviewDate: null,
      goals: [{ description: 'Reduce PHQ-9 below 10', targetDate: null }, { description: 'Attend weekly CBT', targetDate: null }],
    })
    createdPlanIds.push(result.id)
    expect(result.supersededPlanId).toBeNull()

    const [plans] = [await listCarePlansForPatient(patientRow.id)]
    const created = plans.find((p) => p.id === result.id)!
    expect(created.status).toBe('active')
    expect(created.goals).toHaveLength(2)
    expect(created.goals.every((g) => g.status === 'active')).toBe(true)
  })

  it('supersedes the prior active plan instead of deleting it (Review Focus #1)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const first = await createCarePlan({ patientId: patientRow.id, title: 'First Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(first.id)

    const second = await createCarePlan({ patientId: patientRow.id, title: 'Second Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(second.id)
    expect(second.supersededPlanId).toBe(first.id)

    const plans = await listCarePlansForPatient(patientRow.id)
    const firstAfter = plans.find((p) => p.id === first.id)!
    const secondAfter = plans.find((p) => p.id === second.id)!
    expect(firstAfter.status).toBe('superseded')
    expect(firstAfter.supersededAt).not.toBeNull()
    expect(secondAfter.status).toBe('active')
  })
})

describe('listCarePlansForPatient patient scoping (Review Focus #2)', () => {
  it('two patients care plan histories stay independent', async () => {
    const patientsRows = await getDb().select().from(patients).limit(2)
    const [patientA, patientB] = patientsRows
    const planA = await createCarePlan({ patientId: patientA.id, title: 'Plan A', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(planA.id)
    const planB = await createCarePlan({ patientId: patientB.id, title: 'Plan B', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(planB.id)

    const historyA = await listCarePlansForPatient(patientA.id)
    const historyB = await listCarePlansForPatient(patientB.id)
    expect(historyA.some((p) => p.id === planB.id)).toBe(false)
    expect(historyB.some((p) => p.id === planA.id)).toBe(false)
  })
})

describe('updateGoalStatus', () => {
  it('transitions an active goal to a terminal status', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
    createdPlanIds.push(plan.id)
    const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))

    const result = await updateGoalStatus(goal.id, 'met', 'Dr. Test')
    expect(result.ok).toBe(true)

    const [updated] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(updated.status).toBe('met')
    expect(updated.statusUpdatedByName).toBe('Dr. Test')
    expect(updated.statusUpdatedAt).not.toBeNull()
  })

  it('rejects transitioning an already-terminal goal (Review Focus #3)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
    createdPlanIds.push(plan.id)
    const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))

    const first = await updateGoalStatus(goal.id, 'met', 'Dr. Test')
    expect(first.ok).toBe(true)
    const second = await updateGoalStatus(goal.id, 'not_met', 'Dr. Someone Else')
    expect(second.ok).toBe(false)

    const [unchanged] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(unchanged.status).toBe('met') // unchanged by the rejected second call
    expect(unchanged.statusUpdatedByName).toBe('Dr. Test') // not overwritten
  })

  it('only one of two concurrent status updates on the same goal succeeds (Review Focus #5)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
    createdPlanIds.push(plan.id)
    const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))

    const [resultA, resultB] = await Promise.all([
      updateGoalStatus(goal.id, 'met', 'Dr. A'),
      updateGoalStatus(goal.id, 'discontinued', 'Dr. B'),
    ])
    const okCount = [resultA.ok, resultB.ok].filter(Boolean).length
    expect(okCount).toBe(1)
  })
})

// Final whole-branch review (Important finding): createCarePlan did
// SELECT active plan -> UPDATE (supersede) -> INSERT inside a transaction
// with no row lock -- truly concurrent creates for the same patient (a
// double-submit) could all read "no active plan" and all insert an active
// row. Mirrors Task 2's updateGoalStatus concurrency test above (a real
// Promise.all of concurrent calls against the real DB pool), applied one
// level up. Uses three concurrent calls, not two -- verified directly (a
// throwaway script driving the exact same createCarePlan function) that two
// concurrent calls only reliably raced outside this vitest process, while
// three reliably reproduces the race inside vitest's own connection-pool
// timing too; kept at three so this test stays a real regression guard in
// CI, not just at the command line.
// Uses a dedicated TEST-*-${Date.now()} patient, not a random existing one
// -- this test intentionally drives concurrent writers against a single
// patient row, which would be genuinely unsafe to do against shared demo
// data in this concurrently-used DB.
describe('createCarePlan concurrency (Important finding, final whole-branch review)', () => {
  it('only one of three concurrent createCarePlan calls for the same patient ends up active', async () => {
    const db = getDb()
    const testPatientId = `TEST-CP-RACE-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, name: 'Care Plan Race Test Patient', dob: '2000-01-01' })

    try {
      await Promise.all([
        createCarePlan({ patientId: testPatientId, title: 'Plan A', authorName: 'Dr. A', nextReviewDate: null, goals: [] }),
        createCarePlan({ patientId: testPatientId, title: 'Plan B', authorName: 'Dr. B', nextReviewDate: null, goals: [] }),
        createCarePlan({ patientId: testPatientId, title: 'Plan C', authorName: 'Dr. C', nextReviewDate: null, goals: [] }),
      ])

      const activePlans = await db.select().from(carePlans).where(and(eq(carePlans.patientId, testPatientId), eq(carePlans.status, 'active')))
      expect(activePlans.length).toBe(1)
    } finally {
      // Self-contained cleanup (not the module-level createdPlanIds/afterEach
      // hook above) so this runs in the right order regardless of outcome:
      // carePlans.patientId -> patients.id has no ON DELETE action, so any
      // plans/goals this test created must be cleared before the patient row.
      const planRows = await db.select({ id: carePlans.id }).from(carePlans).where(eq(carePlans.patientId, testPatientId))
      const planIds = planRows.map((p) => p.id)
      if (planIds.length > 0) {
        await db.delete(carePlanGoals).where(inArray(carePlanGoals.carePlanId, planIds))
        await db.delete(carePlans).where(eq(carePlans.patientId, testPatientId))
      }
      await db.delete(patients).where(eq(patients.id, testPatientId))
    }
  })
})
