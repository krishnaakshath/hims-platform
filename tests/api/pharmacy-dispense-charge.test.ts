import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/pharmacy/dispenses/[dispenseId]/charge/route'
import { getDb } from '@/db/client'
import { medications, medicationInventory, medicationDispenses, diagnoses, charges } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' = 'pharmacy'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Pharmacy Tester' })) }))

const createdDispenseIds: number[] = []
const createdChargeIds: number[] = []
const createdMedIds: number[] = []

afterEach(async () => {
  sessionRole = 'pharmacy'
  // Order matters: dispenses (which may point at a charge via chargeId)
  // before charges before inventory before medications, matching the FK
  // dependency chain.
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdChargeIds.length > 0) await getDb().delete(charges).where(eq(charges.id, createdChargeIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

// Two distinct seeded patients that each have at least one diagnoses row --
// found dynamically (rather than hardcoded ids) since seed data can shift.
let patientAId: string
let patientBId: string
let dxA: { id: number; code: string; description: string }
let dxB: { id: number; code: string; description: string }

beforeAll(async () => {
  const db = getDb()
  // Scoped column select, not `.select()` -- the live diagnoses table is
  // missing the `source` column the Drizzle schema still declares, so a
  // whole-row select 500s.
  const distinctPatientRows = await db
    .select({ patientId: diagnoses.patientId })
    .from(diagnoses)
    .groupBy(diagnoses.patientId)
    .limit(2)
  ;[patientAId, patientBId] = distinctPatientRows.map((r) => r.patientId)

  const dxRowsA = await db.select({ id: diagnoses.id, code: diagnoses.code, description: diagnoses.description }).from(diagnoses).where(eq(diagnoses.patientId, patientAId)).limit(1)
  dxA = dxRowsA[0]
  const dxRowsB = await db.select({ id: diagnoses.id, code: diagnoses.code, description: diagnoses.description }).from(diagnoses).where(eq(diagnoses.patientId, patientBId)).limit(1)
  dxB = dxRowsB[0]
})

async function makeMedWithStock(qty: number) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Charge Test Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  createdMedIds.push(med.id)
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: qty, reorderThreshold: 5, unit: 'tablets' })
  return med
}

async function makeDispense(patientId: string, medicationId: number, quantity: number) {
  const [dispense] = await getDb().insert(medicationDispenses).values({
    patientId, medicationId, medicationEpisodeId: null, quantity, dispensedByName: 'Test Pharmacist', notes: null,
  }).returning()
  createdDispenseIds.push(dispense.id)
  return dispense
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
function ctx(dispenseId: number) {
  return { params: Promise.resolve({ dispenseId: String(dispenseId) }) }
}
const validBody = (diagnosisId: number) => ({
  diagnosisId, procedureCode: 'J3490', procedureDescription: 'Unclassified drugs - Sertraline', unitChargeCents: 250,
})

describe('POST /api/pharmacy/dispenses/[dispenseId]/charge', () => {
  it('creates a real draft charge and links it to the dispense', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    const res = await POST(req(validBody(dxA.id)) as never, ctx(dispense.id))
    expect(res.status).toBe(201)
    const { chargeId } = await res.json()
    createdChargeIds.push(chargeId)

    const [charge] = await getDb().select().from(charges).where(eq(charges.id, chargeId))
    expect(charge.status).toBe('draft')
    expect(charge.patientId).toBe(dispense.patientId)
    expect(charge.diagnosisCodes).toEqual([{ code: dxA.code, description: dxA.description }])
    expect(charge.procedureCodes).toEqual([{ code: 'J3490', description: 'Unclassified drugs - Sertraline', units: dispense.quantity, chargeCents: 250 }])

    const [updated] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(updated.chargeId).toBe(chargeId)
  })

  it('derives amountCents as quantity * unitChargeCents', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    const res = await POST(req(validBody(dxA.id)) as never, ctx(dispense.id))
    expect(res.status).toBe(201)
    const { chargeId } = await res.json()
    createdChargeIds.push(chargeId)

    const [charge] = await getDb().select().from(charges).where(eq(charges.id, chargeId))
    expect(charge.amountCents).toBe(1500)
  })

  it('rejects a client-supplied amountCents outright (mass-assignment guard)', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    const res = await POST(req({ ...validBody(dxA.id), amountCents: 1 }) as never, ctx(dispense.id))
    expect(res.status).toBe(400)

    const [unchanged] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(unchanged.chargeId).toBeNull()
  })

  // Review Focus #3
  it('returns 409 on a second bill for the same dispense and creates no second charge', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    const before = await getDb().select().from(charges).where(eq(charges.patientId, patientAId))

    const res1 = await POST(req(validBody(dxA.id)) as never, ctx(dispense.id))
    expect(res1.status).toBe(201)
    const { chargeId } = await res1.json()
    createdChargeIds.push(chargeId)

    const res2 = await POST(req(validBody(dxA.id)) as never, ctx(dispense.id))
    expect(res2.status).toBe(409)
    expect((await res2.json()).error).toBe('This dispense has already been billed')

    const after = await getDb().select().from(charges).where(eq(charges.patientId, patientAId))
    expect(after.length - before.length).toBe(1)

    const [unchanged] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(unchanged.chargeId).toBe(chargeId)
  })

  it('creates exactly one charge when two bill calls race', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    const before = await getDb().select().from(charges).where(eq(charges.patientId, patientAId))

    const results = await Promise.allSettled([
      POST(req(validBody(dxA.id)) as never, ctx(dispense.id)),
      POST(req(validBody(dxA.id)) as never, ctx(dispense.id)),
    ])

    const responses = results.map((r) => (r.status === 'fulfilled' ? r.value : null))
    const bodies = await Promise.all(responses.map((r) => (r ? r.json() : null)))

    const successIndexes = responses.map((r, i) => (r && r.status === 201 ? i : -1)).filter((i) => i >= 0)
    expect(successIndexes.length).toBe(1)
    const failureIndexes = responses.map((r, i) => (r && r.status === 409 ? i : -1)).filter((i) => i >= 0)
    expect(failureIndexes.length).toBe(1)

    const chargeId = bodies[successIndexes[0]].chargeId
    createdChargeIds.push(chargeId)

    const [updated] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(updated.chargeId).toBe(chargeId)

    const after = await getDb().select().from(charges).where(eq(charges.patientId, patientAId))
    expect(after.length - before.length).toBe(1)
  })

  // Review Focus #4
  it('rejects a diagnosisId belonging to a different patient with 400 and creates nothing', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    const before = await getDb().select().from(charges).where(eq(charges.patientId, patientAId))

    const res = await POST(req(validBody(dxB.id)) as never, ctx(dispense.id))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('diagnosisId does not belong to this patient')

    const [unchanged] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(unchanged.chargeId).toBeNull()

    const after = await getDb().select().from(charges).where(eq(charges.patientId, patientAId))
    expect(after.length).toBe(before.length)
  })

  it('returns 404 for an unknown dispenseId', async () => {
    const res = await POST(req(validBody(dxA.id)) as never, ctx(999999999))
    expect(res.status).toBe(404)
  })

  it('rejects crc, pi and frontdesk with 403, allows admin', async () => {
    const med = await makeMedWithStock(30)
    const dispense = await makeDispense(patientAId, med.id, 6)

    for (const role of ['crc', 'pi', 'frontdesk'] as const) {
      sessionRole = role
      const res = await POST(req(validBody(dxA.id)) as never, ctx(dispense.id))
      expect(res.status).toBe(403)
    }

    sessionRole = 'admin'
    const res = await POST(req(validBody(dxA.id)) as never, ctx(dispense.id))
    expect(res.status).toBe(201)
    const { chargeId } = await res.json()
    createdChargeIds.push(chargeId)
  })
})
