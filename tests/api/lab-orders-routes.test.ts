import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patients, providers, labTests, labOrders, labResults, labRequisitions } from '@/db/schema'

type Role = 'admin' | 'pi' | 'crc' | 'frontdesk' | 'labs'
// SP5: unique probe names (session and mocked provider), so every audit row these routes write
// (they now audit inside their transactions) is removed in afterAll by patient id + action + name.
const RUN = `${Date.now()}`
const PROBE = `TEST_SP5_LOR-${RUN}`
const PROBE_DR = `Dr. Tsp${RUN}chen`
const PROBE_DR_SUBSTRING = `Dr. Tsp${RUN}che`
let sessionRole: Role = 'admin'
let sessionName = PROBE
// This default session name deliberately doesn't match the mocked
// provider's name below, so order creation exercises the "no match ->
// fall back to the first active provider" branch for 'admin' (see Step 1's
// resolution in the order route, narrowed to 'admin' only per review) and
// the "no match -> reject" branch for 'pi'. Individual tests override this
// where they need a real name match instead.
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName, userId: null })) }))

let mockProviderId = 1
vi.mock('@/lib/queries/providers', () => ({
  listActiveProviders: vi.fn(async () => [{ id: mockProviderId, name: PROBE_DR, credentials: null, specialty: 'Internal Medicine', colorTag: '#000', isActive: true }]),
}))

import { POST as createOrder } from '@/app/api/patients/[anonId]/lab-orders/route'
import { POST as collectOrder } from '@/app/api/lab-orders/[id]/collect/route'
import { POST as resultOrder } from '@/app/api/lab-orders/[id]/result/route'
import { POST as cancelOrderRoute } from '@/app/api/lab-orders/[id]/cancel/route'

const createdOrderIds: number[] = []
// SP5: order creation now writes a requisition plus its orders.
const createdRequisitionIds: number[] = []

let auditPatientId = ''
beforeAll(async () => {
  const [providerRow] = await getDb().select().from(providers).limit(1)
  mockProviderId = providerRow.id
  const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
  auditPatientId = patientRow.id
})

afterAll(async () => {
  await getDb().delete(auditLog).where(and(
    eq(auditLog.patientId, auditPatientId),
    inArray(auditLog.action, ['created lab order', 'marked lab order collected', 'entered lab result', 'cancelled lab order']),
    inArray(auditLog.userName, [PROBE, PROBE_DR, PROBE_DR_SUBSTRING]),
  ))
})

afterEach(async () => {
  sessionRole = 'admin'
  sessionName = PROBE
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
  // SP5: requisitions created through the route (their orders first).
  while (createdRequisitionIds.length > 0) {
    const id = createdRequisitionIds.pop()!
    await getDb().delete(labOrders).where(eq(labOrders.requisitionId, id))
    await getDb().delete(labRequisitions).where(eq(labRequisitions.id, id))
  }
})

async function seedOrder(status: 'ordered' | 'collected' | 'received') {
  const db = getDb()
  const [test] = await db.select().from(labTests).limit(1)
  const [patientRow] = await db.select().from(patients).limit(1)
  const [order] = await db.insert(labOrders).values({
    patientId: patientRow.id,
    labTestId: test.id,
    orderedByProviderId: mockProviderId,
    status,
    collectedAt: status !== 'ordered' ? new Date() : null,
    receivedAt: status === 'received' ? new Date() : null,
  }).returning()
  createdOrderIds.push(order.id)
  return order
}

describe('lab order lifecycle routes — role gating (asymmetric collect gate)', () => {
  describe('POST /api/patients/[anonId]/lab-orders (order creation)', () => {
    it('rejects frontdesk with 403', async () => {
      sessionRole = 'frontdesk'
      const [patientRow] = await getDb().select().from(patients).limit(1)
      const [test] = await getDb().select().from(labTests).limit(1)
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ labTestId: test.id }) })
      const res = await createOrder(req as never, { params: Promise.resolve({ anonId: patientRow.id }) })
      expect(res.status).toBe(403)
    })

    it('allows admin (201)', async () => {
      sessionRole = 'admin'
      const [patientRow] = await getDb().select().from(patients).limit(1)
      const [test] = await getDb().select().from(labTests).limit(1)
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ labTestId: test.id }) })
      const res = await createOrder(req as never, { params: Promise.resolve({ anonId: patientRow.id }) })
      expect(res.status).toBe(201)
      const body = await res.json()
      createdRequisitionIds.push(body.requisitionId) // SP5 response shape
      expect(body.lines).toEqual([expect.objectContaining({ labTestId: test.id })])
    })

    it('allows pi whose session name matches a provider (201, real match — not the admin-only fallback)', async () => {
      sessionRole = 'pi'
      sessionName = PROBE_DR // matches the mocked provider's name below
      const [patientRow] = await getDb().select().from(patients).limit(1)
      const [test] = await getDb().select().from(labTests).limit(1)
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ labTestId: test.id }) })
      const res = await createOrder(req as never, { params: Promise.resolve({ anonId: patientRow.id }) })
      expect(res.status).toBe(201)
      const body = await res.json()
      createdRequisitionIds.push(body.requisitionId) // SP5 response shape
      const [order] = await getDb().select().from(labOrders).where(eq(labOrders.id, body.lines[0].orderId))
      expect(order.orderedByProviderId).toBe(mockProviderId)
    })

    it('rejects a pi session whose name matches no provider, rather than silently misattributing the order (fail closed — matches discharge route precedent)', async () => {
      sessionRole = 'pi'
      sessionName = 'Someone Unmatched' // does not match the mocked provider's name
      const [patientRow] = await getDb().select().from(patients).limit(1)
      const [test] = await getDb().select().from(labTests).limit(1)
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ labTestId: test.id }) })
      const res = await createOrder(req as never, { params: Promise.resolve({ anonId: patientRow.id }) })
      expect(res.status).toBe(403)
    })
    // RBAC Task 18: "Che" is a substring of "Dr. Chen"; the old includes()
    // match attributed this pi's order to Dr. Chen.
    it('rejects a pi whose surname is only a substring of a provider\'s (no fuzzy attribution)', async () => {
      sessionRole = 'pi'
      sessionName = PROBE_DR_SUBSTRING
      const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
      const [test] = await getDb().select().from(labTests).limit(1)
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ labTestId: test.id }) })
      const res = await createOrder(req as never, { params: Promise.resolve({ anonId: patientRow.id }) })
      if (res.status === 201) createdRequisitionIds.push((await res.json()).requisitionId)
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/lab-orders/[id]/collect', () => {
    // frontdesk previously had mark-collected access here -- removed per
    // explicit product direction: front desk's job is registration/
    // check-in only, no lab access at all (not labs, not pharmacy).
    it('rejects frontdesk with 403', async () => {
      const order = await seedOrder('ordered')
      sessionRole = 'frontdesk'
      const res = await collectOrder(new Request('http://localhost', { method: 'POST' }) as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(403)
    })

    it('allows admin', async () => {
      const order = await seedOrder('ordered')
      sessionRole = 'admin'
      const res = await collectOrder(new Request('http://localhost', { method: 'POST' }) as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect([200, 204]).toContain(res.status)
    })

    it('allows pi', async () => {
      const order = await seedOrder('ordered')
      sessionRole = 'pi'
      const res = await collectOrder(new Request('http://localhost', { method: 'POST' }) as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect([200, 204]).toContain(res.status)
    })
  })

  // SP5: a staff result needs the sample received first; labs (+admin) enter results, pi verifies.
  describe('POST /api/lab-orders/[id]/result', () => {
    it.each(['frontdesk', 'pi'] as const)('rejects %s with 403', async (r) => {
      const order = await seedOrder('received')
      sessionRole = r
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ value: '5', flag: 'normal' }) })
      const res = await resultOrder(req as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(403)
    })

    it.each(['admin', 'labs'] as const)('allows %s on a received order', async (r) => {
      const order = await seedOrder('received')
      sessionRole = r
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ value: '5', flag: 'normal' }) })
      const res = await resultOrder(req as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(200)
      const [row] = await getDb().select({ status: labOrders.status }).from(labOrders).where(eq(labOrders.id, order.id))
      expect(row.status).toBe('resulted')
    })

    it('409s a collected order that was never received', async () => {
      const order = await seedOrder('collected')
      sessionRole = 'labs'
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ value: '5', flag: 'normal' }) })
      const res = await resultOrder(req as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(409)
    })
  })

  describe('POST /api/lab-orders/[id]/cancel', () => {
    it('rejects frontdesk with 403', async () => {
      const order = await seedOrder('ordered')
      sessionRole = 'frontdesk'
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'test' }) })
      const res = await cancelOrderRoute(req as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(403)
    })

    it('allows admin', async () => {
      const order = await seedOrder('ordered')
      sessionRole = 'admin'
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'test' }) })
      const res = await cancelOrderRoute(req as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(200)
    })

    it('allows pi', async () => {
      const order = await seedOrder('ordered')
      sessionRole = 'pi'
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'test' }) })
      const res = await cancelOrderRoute(req as never, { params: Promise.resolve({ id: String(order.id) }) })
      expect(res.status).toBe(200)
    })
  })
})
