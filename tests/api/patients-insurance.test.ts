import { describe, it, expect, vi, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { POST as createRoute } from '@/app/api/patients/route'
import { getDb } from '@/db/client'
import { patients, payers, patientAadhaar, auditLog } from '@/db/schema'

// vi.mock is hoisted above module-level consts, so the factory reads the
// probe name lazily through vi.hoisted -- one constant for session and cleanup.
const { PROBE_USER } = vi.hoisted(() => ({ PROBE_USER: 'Taylor Nguyen' }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: PROBE_USER, userId: null })) }))

const createdPatientIds: string[] = []
afterEach(async () => {
  while (createdPatientIds.length > 0) {
    const id = createdPatientIds.pop()!
    await getDb().delete(auditLog).where(and(eq(auditLog.patientId, id), eq(auditLog.userName, PROBE_USER)))
    await getDb().delete(patientAadhaar).where(eq(patientAadhaar.patientId, id))
    await getDb().delete(patients).where(eq(patients.id, id))
  }
})

// SP1 registration shape; Aadhaar declined so no encryption key is needed.
const registration = (over: Record<string, unknown>) => ({
  dob: '1990-01-01', gender: 'other', addressLine1: '1 Residency Road', city: 'Bengaluru', district: 'Bengaluru Urban',
  stateCode: 'IN-KA', pinCode: '560025',
  aadhaar: { status: 'declined', reason: 'patient_declined' },
  abha: { status: 'unavailable', reason: 'not_created' },
  ...over,
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

// The 201 body is only { id, uhid } now, so stored values are read back from the DB.
const rowFor = async (id: string) => (await getDb().select().from(patients).where(eq(patients.id, id)))[0]

describe('POST /api/patients — insurance fields', () => {
  it('creates a patient with primary insurance fields set', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const res = await createRoute(req(registration({
      name: 'Insurance Test Patient',
      primaryPayerId: payer.id, primaryMemberId: 'M100', primaryGroupNumber: 'G200',
      primaryPlanType: 'ppo', primarySubscriberName: 'Insurance Test Patient', primarySubscriberRelationship: 'self',
    })) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPatientIds.push(body.id)
    const row = await rowFor(body.id)
    expect(row.primaryPayerId).toBe(payer.id)
    expect(row.primaryMemberId).toBe('M100')
  })

  it('creates a patient with no insurance fields at all (self-pay, still valid)', async () => {
    const res = await createRoute(req(registration({ name: 'No Insurance Patient' })) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPatientIds.push(body.id)
    expect((await rowFor(body.id)).primaryPayerId).toBeNull()
  })

  it('rejects a primaryPayerId that does not exist in the payers table', async () => {
    const res = await createRoute(req(registration({ name: 'Bad Payer Patient', primaryPayerId: 999999 })) as never)
    expect(res.status).toBe(400)
  })

  it('two patients created with different insurance stay independent', async () => {
    const allPayers = await getDb().select().from(payers).limit(2)
    const [payerA, payerB] = allPayers
    const resA = await createRoute(req(registration({ name: 'Patient A', primaryPayerId: payerA.id, primaryMemberId: 'MEMBER-A' })) as never)
    const bodyA = await resA.json()
    createdPatientIds.push(bodyA.id)
    const resB = await createRoute(req(registration({ name: 'Patient B', dob: '1991-01-01', primaryPayerId: payerB.id, primaryMemberId: 'MEMBER-B' })) as never)
    const bodyB = await resB.json()
    createdPatientIds.push(bodyB.id)

    // Read both from the DB directly -- two genuinely independent rows.
    const rowA = await rowFor(bodyA.id)
    const rowB = await rowFor(bodyB.id)
    expect(rowA.primaryPayerId).toBe(payerA.id)
    expect(rowA.primaryMemberId).toBe('MEMBER-A')
    expect(rowB.primaryPayerId).toBe(payerB.id)
    expect(rowB.primaryMemberId).toBe('MEMBER-B')
  })
})
