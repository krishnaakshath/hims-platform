import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'

const createdPlanIds: number[] = []
afterEach(async () => {
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

describe('care plans schema', () => {
  it('creates a plan with a goal, defaulting to active status', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)

    const [plan] = await db.insert(carePlans).values({ patientId: patientRow.id, title: 'Test Plan', authorName: 'Dr. Test' }).returning()
    createdPlanIds.push(plan.id)
    expect(plan.status).toBe('active')
    expect(plan.supersededAt).toBeNull()

    const [goal] = await db.insert(carePlanGoals).values({ carePlanId: plan.id, description: 'Attend weekly CBT' }).returning()
    expect(goal.status).toBe('active')
    expect(goal.statusUpdatedAt).toBeNull()
    expect(goal.statusUpdatedByName).toBeNull()
  })

  it('rejects a goal referencing a nonexistent care plan', async () => {
    const db = getDb()
    await expect(db.insert(carePlanGoals).values({ carePlanId: 999999999, description: 'Orphan goal' })).rejects.toThrow()
  })
})
