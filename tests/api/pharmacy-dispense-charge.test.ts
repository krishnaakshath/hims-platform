// WS2 T8 (spec ruling 7): POST /api/pharmacy/dispenses/[dispenseId]/charge bills a legacy unbilled
// dispense (one made before dispensing billed itself) once, at the medicine's current MRP.
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { POST } from '@/app/api/pharmacy/dispenses/[dispenseId]/charge/route'
import { getDb } from '@/db/client'
import { auditLog, charges, chargeLines, medications, medicationInventory, medicationDispenses, patients } from '@/db/schema'
import { purgeBillingFixtures } from '../db/billing-fixtures'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' = 'pharmacy'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Pharmacy Tester', userId: null })) }))

const TAG = `TWS2T8L-${Date.now()}`
const PID = `${TAG}-P`
const med = { priced: 0, unpriced: 0 }
const chargeIds: number[] = []

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values({ id: PID, name: 'TEST legacy dispense', dob: '1990-01-01' })
  const rows = await db.insert(medications).values([
    { name: `${TAG} Priced`, medicationClass: 'Test', form: 'tablet', mrpPerUnitPaise: 350, gstRateBp: 1200, hsn: '30049099' },
    { name: `${TAG} Unpriced`, medicationClass: 'Test', form: 'tablet' },
  ]).returning()
  ;[med.priced, med.unpriced] = rows.map((r) => r.id)
  await db.insert(medicationInventory).values(rows.map((r) => ({ medicationId: r.id, quantityOnHand: 50, unit: 'tablets' })))
})

afterEach(async () => {
  sessionRole = 'pharmacy'
  await purgeBillingFixtures([PID])
  await getDb().delete(medicationDispenses).where(eq(medicationDispenses.patientId, PID))
  if (chargeIds.length) await getDb().delete(charges).where(inArray(charges.id, chargeIds.splice(0)))
})

afterAll(async () => {
  const db = getDb()
  const ids = Object.values(med)
  await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, ids))
  await db.delete(medications).where(inArray(medications.id, ids))
  await db.delete(patients).where(eq(patients.id, PID))
})

async function legacyDispense(medicationId: number, quantity = 15, chargeId: number | null = null) {
  const [d] = await getDb().insert(medicationDispenses).values({
    patientId: PID, medicationId, quantity, dispensedByName: 'Old Pharmacist', dispensedAt: new Date('2026-10-01T18:40:00Z'), chargeId,
  }).returning()
  return d
}
function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
const ctx = (id: number | string) => ({ params: Promise.resolve({ dispenseId: String(id) }) })

describe('POST /api/pharmacy/dispenses/[dispenseId]/charge (bill a legacy dispense at current MRP)', () => {
  it('bills an unbilled legacy dispense once at the current MRP; a second call is 409', async () => {
    const d = await legacyDispense(med.priced)
    const res = await POST(req({}) as never, ctx(d.id))
    expect(res.status).toBe(201)
    const { lineId } = await res.json()
    const lines = await getDb().select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, d.id))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      id: lineId, patientId: PID, source: 'pharmacy', priceSource: 'pharmacy', itemCode: `MED-${med.priced}`, itemName: `${TAG} Priced`,
      quantity: 15, unitPricePaise: 312, taxablePaise: 4680, gstRateBp: 1200, hsnSac: '30049099', serviceDate: '2026-10-02', legacyChargeId: null,
    })
    expect(await getDb().select().from(charges).where(eq(charges.patientId, PID))).toHaveLength(0)
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, PID), eq(auditLog.action, 'billed a legacy dispense'))).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`dispense=${d.id} line=${lineId}`)

    const again = await POST(req({}) as never, ctx(d.id))
    expect(again.status).toBe(409)
    expect(await getDb().select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, d.id))).toHaveLength(1)
  })

  it('two concurrent calls bill once', async () => {
    const d = await legacyDispense(med.priced, 4)
    const statuses = (await Promise.all([POST(req({}) as never, ctx(d.id)), POST(req({}) as never, ctx(d.id))])).map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409])
    expect(await getDb().select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, d.id))).toHaveLength(1)
  })

  it('a dispense billed on the pre-SP4 charges table is already billed', async () => {
    const [c] = await getDb().insert(charges).values({ patientId: PID, providerName: 'Dr Old', dateOfService: '2026-10-01', diagnosisCodes: [], procedureCodes: [], amountCents: 100, status: 'draft' }).returning()
    chargeIds.push(c.id)
    const d = await legacyDispense(med.priced, 2, c.id)
    expect((await POST(req({}) as never, ctx(d.id))).status).toBe(409)
  })

  it('an unpriced medicine is 422; an unknown dispense 404; any body key 400', async () => {
    const d = await legacyDispense(med.unpriced)
    const unpriced = await POST(req({}) as never, ctx(d.id))
    expect(unpriced.status).toBe(422)
    expect((await unpriced.json()).code).toBe('medication_unpriced')
    expect((await POST(req({}) as never, ctx(999999999))).status).toBe(404)
    const p = await legacyDispense(med.priced)
    expect((await POST(req({ unitChargeCents: 1 }) as never, ctx(p.id))).status).toBe(400)
  })

  it('pi and billing are 403', async () => {
    const d = await legacyDispense(med.priced)
    for (const role of ['pi', 'billing'] as const) {
      sessionRole = role
      expect((await POST(req({}) as never, ctx(d.id))).status).toBe(403)
    }
  })
})
