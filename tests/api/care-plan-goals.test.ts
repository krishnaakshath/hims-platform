import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PATCH as updateGoalRoute } from '@/app/api/care-plan-goals/[id]/route'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'
import { createCarePlan } from '@/lib/queries/care-plans'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdPlanIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

async function makeGoal() {
  const [patientRow] = await getDb().select().from(patients).limit(1)
  const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
  createdPlanIds.push(plan.id)
  const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))
  return goal
}

describe('PATCH /api/care-plan-goals/[id]', () => {
  it('transitions an active goal to met as pi, capturing the session name', async () => {
    const goal = await makeGoal()
    const res = await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(res.status).toBe(200)

    const [updated] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(updated.status).toBe('met')
    expect(updated.statusUpdatedByName).toBe('Dr. R. Kunam')
  })

  it('rejects transitioning an already-terminal goal with 409 (Review Focus #3)', async () => {
    const goal = await makeGoal()
    await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    const second = await updateGoalRoute(req({ status: 'not_met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(second.status).toBe(409)
  })

  it('never trusts a client-supplied statusUpdatedByName (Review Focus #4)', async () => {
    const goal = await makeGoal()
    const res = await updateGoalRoute(req({ status: 'met', statusUpdatedByName: 'Dr. Someone Else' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(res.status).toBe(400) // .strict() rejects the unknown key outright

    const [unchanged] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(unchanged.status).toBe('active') // the rejected request never wrote anything
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const goal = await makeGoal()
    const res = await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(res.status).toBe(403)
  })

  it('404s for a nonexistent goal id', async () => {
    const res = await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: '999999999' }) })
    expect(res.status).toBe(404)
  })
})
