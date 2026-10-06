import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createRoute } from '@/app/api/patients/route'
import { getDb } from '@/db/client'
import { patients, payers } from '@/db/schema'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))

const createdPatientIds: string[] = []
afterEach(async () => {
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients — insurance fields', () => {
  it('creates a patient with primary insurance fields set', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const res = await createRoute(req({
      name: 'Insurance Test Patient', dob: '1990-01-01',
      primaryPayerId: payer.id, primaryMemberId: 'M100', primaryGroupNumber: 'G200',
      primaryPlanType: 'ppo', primarySubscriberName: 'Insurance Test Patient', primarySubscriberRelationship: 'self',
    }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPatientIds.push(body.id)
    expect(body.primaryPayerId).toBe(payer.id)
    expect(body.primaryMemberId).toBe('M100')
  })

  it('creates a patient with no insurance fields at all (self-pay, still valid)', async () => {
    const res = await createRoute(req({ name: 'No Insurance Patient', dob: '1990-01-01' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPatientIds.push(body.id)
    expect(body.primaryPayerId).toBeNull()
  })

  it('rejects a primaryPayerId that does not exist in the payers table', async () => {
    const res = await createRoute(req({ name: 'Bad Payer Patient', dob: '1990-01-01', primaryPayerId: 999999 }) as never)
    expect(res.status).toBe(400)
  })

  it('two patients created with different insurance stay independent', async () => {
    const allPayers = await getDb().select().from(payers).limit(2)
    const [payerA, payerB] = allPayers
    const resA = await createRoute(req({ name: 'Patient A', dob: '1990-01-01', primaryPayerId: payerA.id, primaryMemberId: 'MEMBER-A' }) as never)
    const bodyA = await resA.json()
    createdPatientIds.push(bodyA.id)
    const resB = await createRoute(req({ name: 'Patient B', dob: '1991-01-01', primaryPayerId: payerB.id, primaryMemberId: 'MEMBER-B' }) as never)
    const bodyB = await resB.json()
    createdPatientIds.push(bodyB.id)

    expect(bodyA.primaryPayerId).toBe(payerA.id)
    expect(bodyA.primaryMemberId).toBe('MEMBER-A')
    expect(bodyB.primaryPayerId).toBe(payerB.id)
    expect(bodyB.primaryMemberId).toBe('MEMBER-B')
    // Re-read both from the DB directly -- proves this isn't just the
    // create response echoing back the request, but two genuinely
    // independent rows.
    const [rowA] = await getDb().select().from(patients).where(eq(patients.id, bodyA.id))
    const [rowB] = await getDb().select().from(patients).where(eq(patients.id, bodyB.id))
    expect(rowA.primaryMemberId).toBe('MEMBER-A')
    expect(rowB.primaryMemberId).toBe('MEMBER-B')
  })
})
