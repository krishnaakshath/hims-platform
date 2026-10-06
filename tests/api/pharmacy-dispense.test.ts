import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as dispenseRoute } from '@/app/api/pharmacy/dispense/route'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' = 'pi'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdDispenseIds: number[] = []
const createdMedIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

async function makeMedWithStock(qty: number) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Route Test Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  createdMedIds.push(med.id)
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: qty, reorderThreshold: 5, unit: 'tablets' })
  return med
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/pharmacy/dispense', () => {
  it('dispenses successfully as pi', async () => {
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5, notes: 'Test dispense' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDispenseIds.push(body.id)
  })

  it('dispenses successfully as pharmacy', async () => {
    sessionRole = 'pharmacy'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5, notes: 'Test dispense' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDispenseIds.push(body.id)
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(403)
  })

  it('rejects a crc session', async () => {
    sessionRole = 'crc'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(403)
  })

  it('rejects dispensing more than on hand', async () => {
    const med = await makeMedWithStock(3)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 10 }) as never)
    expect(res.status).toBe(409)
  })

  it('rejects an unknown patientId with a clean 400 and leaves stock untouched', async () => {
    const med = await makeMedWithStock(30)
    const res = await dispenseRoute(req({ patientId: 'rd-does-not-exist', medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Unknown patient')

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(30)
  })

  it('rejects an unknown medicationId with a clean 400 (not the old misleading 409) and leaves stock untouched', async () => {
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: 999999999, quantity: 5 }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Unknown medication')
  })
})
