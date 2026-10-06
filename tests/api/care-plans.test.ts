import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createRoute } from '@/app/api/patients/[anonId]/care-plans/route'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'

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
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients/[anonId]/care-plans', () => {
  it('creates a plan as pi, authored from the session name', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ title: 'Q4 Plan', goals: [{ description: 'Attend weekly CBT' }] }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPlanIds.push(body.id)

    const [planRow] = await getDb().select().from(carePlans).where(eq(carePlans.id, body.id))
    expect(planRow.authorName).toBe('Dr. R. Kunam')
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ title: 'Q4 Plan', goals: [] }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(403)
  })

  it('rejects an unknown field in the body (.strict())', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ title: 'Q4 Plan', goals: [], authorName: 'Someone Else' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(400)
  })
})
