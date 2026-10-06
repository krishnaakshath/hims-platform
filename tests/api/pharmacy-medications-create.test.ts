import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createMedicationRoute } from '@/app/api/pharmacy/medications/route'
import { getDb } from '@/db/client'
import { medications, medicationInventory } from '@/db/schema'
import { listMedicationsWithInventory } from '@/lib/queries/medications'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' = 'pharmacy'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdMedIds: number[] = []
afterEach(async () => {
  sessionRole = 'pharmacy'
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: `Zz Route Med ${Date.now()}-${Math.random()}`,
    medicationClass: 'Test Class',
    form: 'tablet',
    quantityOnHand: 40,
    reorderThreshold: 10,
    unit: 'tablets',
    ...overrides,
  }
}

describe('POST /api/pharmacy/medications', () => {
  it('creates the catalog and inventory rows as pharmacy', async () => {
    const res = await createMedicationRoute(req(validPayload()) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(typeof body.id).toBe('number')
    createdMedIds.push(body.id)
  })

  it('creates them as admin too', async () => {
    sessionRole = 'admin'
    const res = await createMedicationRoute(req(validPayload()) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdMedIds.push(body.id)
  })

  it('rejects pi, crc and frontdesk', async () => {
    for (const role of ['pi', 'crc', 'frontdesk'] as const) {
      sessionRole = role
      const res = await createMedicationRoute(req(validPayload()) as never)
      expect(res.status).toBe(403)
    }
  })

  it('rejects a case-insensitive duplicate name with 409', async () => {
    const name = `Zz Dup Med ${Date.now()}`
    const first = await createMedicationRoute(req(validPayload({ name })) as never)
    expect(first.status).toBe(201)
    const firstBody = await first.json()
    createdMedIds.push(firstBody.id)

    const second = await createMedicationRoute(req(validPayload({ name: name.toUpperCase() })) as never)
    expect(second.status).toBe(409)
  })

  it('rejects an unexpected extra field (mass-assignment guard)', async () => {
    const res = await createMedicationRoute(req(validPayload({ extraField: 'nope' })) as never)
    expect(res.status).toBe(400)
  })

  it('makes the new drug appear in listMedicationsWithInventory()', async () => {
    const payload = validPayload()
    const res = await createMedicationRoute(req(payload) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdMedIds.push(body.id)

    const all = await listMedicationsWithInventory()
    const created = all.find((m) => m.id === body.id)
    expect(created?.quantityOnHand).toBe(40)
  })
})
