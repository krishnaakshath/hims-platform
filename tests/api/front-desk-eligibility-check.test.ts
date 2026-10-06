import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/front-desk/eligibility-check/route'
import { getDb } from '@/db/client'
import { insuranceEligibilityChecks, payers, patients } from '@/db/schema'

// Insurance verification moved fully to billing (explicit product
// direction) -- the route path still lives under /api/front-desk/ (a rename
// would ripple into EligibilityCheckButton's fetch call and beyond for no
// behavioral gain), but the only role that can call it now is billing.
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'billing', name: 'Alex Billing' })) }))

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.id, createdIds.pop()!))
})

describe('POST /api/front-desk/eligibility-check', () => {
  it('records and returns a simulated eligibility result', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerId: payer.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdIds.push(body.id)
    expect(['verified', 'inactive', 'needs_follow_up']).toContain(body.status)
  })

  it('returns 403 for a pi session', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Kunam', userId: null })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerId: payer.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
  })

  it('returns 403 for a frontdesk session (insurance moved fully to billing)', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerId: payer.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
  })

  it('rejects a payload with an unknown field', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerId: payer.id, extra: true }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('accepts a payerId instead of free-text payerName and returns a richer eligibility response', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: patientRow.id, payerId: payer.id }) }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdIds.push(body.id)
    expect(body.payerId).toBe(payer.id)
    expect('deductibleRemainingCents' in body).toBe(true)
  })

  it('rejects a payerId that does not exist', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: patientRow.id, payerId: 999999 }) }) as never)
    expect(res.status).toBe(400)
  })
})
