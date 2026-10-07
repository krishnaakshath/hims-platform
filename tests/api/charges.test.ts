import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import { GET, POST } from '@/app/api/charges/route'
import { GET as getOne, PATCH } from '@/app/api/charges/[id]/route'
import { getDb } from '@/db/client'
import { charges } from '@/db/schema'
import { inArray, eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'coder' = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))

// getDb is wrapped (still the real one) so the 403 tests can prove a denied
// role never reaches the database. logAudit is mocked: audit_log rows are
// append-only compliance records and this suite must never delete them.
vi.mock('@/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/client')>()
  return { ...actual, getDb: vi.fn(actual.getDb) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

afterEach(() => { sessionRole = 'crc' })

// This suite exercises the real create/PATCH DB path against the shared dev
// database (not mocked), so every charge it creates is tracked here and
// deleted afterward -- otherwise these rows accumulate permanently, since
// seed()'s guard against destructive reseeds means a non-empty `charges`
// table is never cleared between runs.
const createdChargeIds: number[] = []
afterAll(async () => {
  if (createdChargeIds.length > 0) await getDb().delete(charges).where(inArray(charges.id, createdChargeIds))
})

describe('GET /api/charges', () => {
  it('returns the seeded charges', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(11)
  })
})

describe('GET /api/charges audit logging', () => {
  it('logs an audit entry when the charges list is viewed', async () => {
    vi.mocked(logAudit).mockClear()
    await GET()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'crc' }), 'viewed charges list', null)
  })

  it('logs an audit entry when a single charge is viewed', async () => {
    const [existing] = await getDb().select().from(charges).limit(1)
    vi.mocked(logAudit).mockClear()
    await getOne(new Request(`http://localhost/api/charges/${existing.id}`) as never, { params: Promise.resolve({ id: String(existing.id) }) })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'crc' }), `viewed charge ${existing.id}`, existing.patientId)
  })
})

describe('GET charge reads role gating', () => {
  const denied = ['pi', 'frontdesk', 'pharmacy', 'labs', 'coder'] as const
  const allowed = ['admin', 'crc', 'billing'] as const

  it.each(denied)('403s %s on GET /api/charges with no DB read', async (role) => {
    sessionRole = role
    vi.mocked(getDb).mockClear()
    vi.mocked(logAudit).mockClear()
    const res = await GET()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(getDb).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it.each(denied)('403s %s on GET /api/charges/[id] with no DB read', async (role) => {
    sessionRole = role
    vi.mocked(getDb).mockClear()
    vi.mocked(logAudit).mockClear()
    const res = await getOne(new Request('http://localhost/api/charges/1') as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(getDb).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it.each(allowed)('admits %s on both charge reads', async (role) => {
    sessionRole = role
    const [existing] = await getDb().select().from(charges).limit(1)
    expect((await GET()).status).toBe(200)
    const one = await getOne(new Request('http://localhost') as never, { params: Promise.resolve({ id: String(existing.id) }) })
    expect(one.status).toBe(200)
  })
})

describe('POST /api/charges', () => {
  it('rejects a payload missing procedure codes', async () => {
    const req = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17', diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }], procedureCodes: [] }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects a payload with an unexpected extra field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 }],
        status: 'submitted',
      }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a new charge in draft status with amountCents derived from procedureCodes, never trusted from the client', async () => {
    const req = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [
          { code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 },
          { code: '99213', description: 'Office visit', units: 2, chargeCents: 5000 },
        ],
      }),
    })
    const res = await POST(req as never)
    const body = await res.json()
    if (body.id) createdChargeIds.push(body.id)
    expect(res.status).toBe(201)
    expect(body.status).toBe('draft')
    expect(body.amountCents).toBe(25000) // 15000 + 2*5000, computed server-side
  })
})

describe('GET /api/charges/[id]', () => {
  it('returns a single charge', async () => {
    const createReq = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId: 'RD-0002', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 }],
      }),
    })
    const created = await (await POST(createReq as never)).json()
    if (created.id) createdChargeIds.push(created.id)

    const res = await getOne(new Request('http://localhost') as never, { params: Promise.resolve({ id: String(created.id) }) })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.id).toBe(created.id)
  })

  it('returns 404 for a nonexistent charge', async () => {
    const res = await getOne(new Request('http://localhost') as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/charges/[id]', () => {
  async function createDraft(patientId: string) {
    const createReq = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId, providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 }],
      }),
    })
    const created = await (await POST(createReq as never)).json()
    if (created.id) createdChargeIds.push(created.id)
    return created
  }

  it('rejects an illegal status transition (draft straight to submitted)', async () => {
    const created = await createDraft('RD-0001')
    const req = new Request(`http://localhost/api/charges/${created.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'submitted' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(400)
  })

  it('allows a legal status transition (draft to pending_approval)', async () => {
    const created = await createDraft('RD-0003')
    const req = new Request(`http://localhost/api/charges/${created.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending_approval' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(200)

    const check = await getOne(new Request('http://localhost') as never, { params: Promise.resolve({ id: String(created.id) }) })
    const body = await check.json()
    expect(body.status).toBe('pending_approval')
  })

  it('returns 404 for a nonexistent charge', async () => {
    const req = new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ status: 'pending_approval' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })
})

describe('charges route role gating', () => {
  function validChargeBody(patientId: string) {
    return new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId, providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 }],
      }),
    })
  }

  it('rejects a pharmacy session on POST /api/charges', async () => {
    sessionRole = 'pharmacy'
    const res = await POST(validChargeBody('RD-0001') as never)
    expect(res.status).toBe(403)
  })

  it('rejects a pi session on POST /api/charges -- incidental access the missing gate allowed', async () => {
    sessionRole = 'pi'
    const res = await POST(validChargeBody('RD-0001') as never)
    expect(res.status).toBe(403)
  })

  it('rejects a pharmacy session on PATCH /api/charges/[id]', async () => {
    sessionRole = 'crc'
    const created = await (await POST(validChargeBody('RD-0001') as never)).json()
    if (created.id) createdChargeIds.push(created.id)

    sessionRole = 'pharmacy'
    const req = new Request(`http://localhost/api/charges/${created.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending_approval' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(403)

    // Narrow select on `charges` alone (no `patients` join) -- getOne()/getCharge()
    // join to `patients` for patientName/patientDob, which in this shared dev DB
    // currently 500s due to unrelated column drift from a concurrent worktree's
    // migration. Asserting directly against `charges` avoids that entirely.
    const [row] = await getDb().select({ status: charges.status }).from(charges).where(eq(charges.id, created.id))
    expect(row?.status).toBe('draft')
  })

  it('rejects a pi session on PATCH /api/charges/[id]', async () => {
    sessionRole = 'crc'
    const created = await (await POST(validChargeBody('RD-0001') as never)).json()
    if (created.id) createdChargeIds.push(created.id)

    sessionRole = 'pi'
    const req = new Request(`http://localhost/api/charges/${created.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending_approval' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects a frontdesk session on POST /api/charges -- billing/registration staff means admin/crc/billing, not frontdesk', async () => {
    sessionRole = 'frontdesk'
    const res = await POST(validChargeBody('RD-0001') as never)
    expect(res.status).toBe(403)
  })

  it('still allows admin and billing on POST /api/charges', async () => {
    sessionRole = 'admin'
    const adminRes = await POST(validChargeBody('RD-0001') as never)
    expect(adminRes.status).toBe(201)
    const adminBody = await adminRes.json()
    if (adminBody.id) createdChargeIds.push(adminBody.id)

    sessionRole = 'billing'
    const billingRes = await POST(validChargeBody('RD-0001') as never)
    expect(billingRes.status).toBe(201)
    const billingBody = await billingRes.json()
    if (billingBody.id) createdChargeIds.push(billingBody.id)
  })
})
