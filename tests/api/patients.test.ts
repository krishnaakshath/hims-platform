import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { patients, patientAadhaar, auditLog } from '@/db/schema'
import { invalidateCache, patientListCacheKey, patientDetailCacheKey } from '@/lib/cache'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
import { GET as listPatients, POST as createPatient } from '@/app/api/patients/route'
import { GET as getPatient, DELETE as deletePatientRoute } from '@/app/api/patients/[anonId]/route'

// The global setup mock (vitest.setup.ts) stubs `next/headers` so `getSession()`
// resolves to "no session" — that's correct for testing the 401 paths below, but
// these routes are PHI-shaped and require an authenticated session for their
// success paths too. The routes call `requireSession()` (not `getSession()`
// directly), so that's what must be mocked here — mocking `getSession` alone
// wouldn't work, since `requireSession`'s own implementation calls its
// module-internal `getSession` reference, not the re-exported one this file
// could override. Override `requireSession` to return a real session object by
// default, and to return a real 401 NextResponse per-test where we're
// specifically checking the 401 behavior. (Vitest hoists `vi.mock` above all
// imports in this file, including the ones written above it, so this applies
// regardless of order.)
// Default role is frontdesk -- POST /api/patients (patient registration) is
// admin/frontdesk exclusively, crc removed per explicit product direction.
// The GET describes switch to crc in a beforeEach: GET list/detail are
// CLINICAL_ROLES only (RBAC ruling 1, frontdesk denied). Read lazily by the
// mock below, only once a route actually calls requireSession.
let sessionRole: auth.Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})

afterEach(() => {
  sessionRole = 'frontdesk'
})

describe('GET /api/patients and /api/patients/[anonId] -- RBAC ruling 1', () => {
  it('403s frontdesk on GET list', async () => {
    sessionRole = 'frontdesk'
    const list = await listPatients(new NextRequest('http://localhost/api/patients'))
    expect(list.status).toBe(403)
    expect(await list.json()).toEqual({ error: 'Forbidden' })
  })

  // The billing eligibility modal reads the payer from
  // /api/patients/[anonId]/primary-payer instead (controller ruling, option b).
  it('403s frontdesk, pharmacy, billing and labs on GET detail', async () => {
    for (const role of ['frontdesk', 'pharmacy', 'billing', 'labs', 'coder'] as const) {
      sessionRole = role
      const detail = await getPatient(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
      expect(detail.status, `role ${role}`).toBe(403)
      expect(await detail.json(), `body for ${role}`).toEqual({ error: 'Forbidden' })
    }
  })
})

describe('GET /api/patients', () => {
  beforeEach(() => { sessionRole = 'crc' })

  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const response = await listPatients(new NextRequest('http://localhost/api/patients'))
    expect(response.status).toBe(401)
  })

  it('returns a list of patients with their overall screening status', async () => {
    const response = await listPatients(new NextRequest('http://localhost/api/patients'))
    const body = await response.json()
    expect(Array.isArray(body.patients)).toBe(true)
    expect(body.patients[0]).toHaveProperty('overallStatus')
  })

  it('filters by trialId when provided', async () => {
    const response = await listPatients(new NextRequest('http://localhost/api/patients?trialId=nct06911112'))
    const body = await response.json()
    expect(body.patients.every((p: { trialId: string | null }) => p.trialId === 'nct06911112')).toBe(true)
  })
})

describe('GET /api/patients/[anonId]', () => {
  beforeEach(() => { sessionRole = 'crc' })

  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const response = await getPatient(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(response.status).toBe(401)
  })

  it('returns full 30-field detail plus criteria evidence for a known patient', async () => {
    const response = await getPatient(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    const body = await response.json()
    expect(body.id).toBe('RD-0001')
    expect(body.criteria.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown anonymous id', async () => {
    const response = await getPatient(new NextRequest('http://localhost/api/patients/RD-9999'), { params: Promise.resolve({ anonId: 'RD-9999' }) })
    expect(response.status).toBe(404)
  })

  it('returns 200 for a pi session -- spec §6.1: this plan\'s sweep left the read path open to the whole chart', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI', userId: null })
    const response = await getPatient(new NextRequest('http://localhost/api/patients/RD-0001'), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(response.status).toBe(200)
  })
})

describe('patient list/detail never expose the encrypted TOTP secret', () => {
  beforeEach(() => { sessionRole = 'crc' })

  // Both responses are built from whole-row spreads of `patients` and are
  // Redis-cached, so a column added to that table rides along to the client
  // and into the cache unless it's explicitly stripped. Uses its own
  // throwaway patient with a real (fake) secret on file, and invalidates the
  // read-through caches around it so the assertions see a fresh query rather
  // than a 30s-old cached copy that predates this row.
  const LEAK_TEST_ID = 'RD-MFA-LEAK-01'

  beforeAll(async () => {
    await getDb().insert(patients).values({
      id: LEAK_TEST_ID, name: 'MFA Leak Test Patient', dob: '1990-01-01',
      mfaSecretEncrypted: 'enc-secret-that-must-not-leak', mfaEnabled: true,
    })
    await invalidateCache(patientListCacheKey(null))
    await invalidateCache(patientDetailCacheKey(LEAK_TEST_ID))
  })

  afterAll(async () => {
    await getDb().delete(patients).where(eq(patients.id, LEAK_TEST_ID))
    await invalidateCache(patientListCacheKey(null))
    await invalidateCache(patientDetailCacheKey(LEAK_TEST_ID))
  })

  it('GET /api/patients/[anonId] omits mfaSecretEncrypted but still reports mfaEnabled', async () => {
    const response = await getPatient(new NextRequest(`http://localhost/api/patients/${LEAK_TEST_ID}`), { params: Promise.resolve({ anonId: LEAK_TEST_ID }) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('mfaSecretEncrypted')
    expect(body.mfaEnabled).toBe(true)
    expect(JSON.stringify(body)).not.toContain('enc-secret-that-must-not-leak')
  })

  it('GET /api/patients omits mfaSecretEncrypted from every row', async () => {
    const response = await listPatients(new NextRequest('http://localhost/api/patients'))
    const body = await response.json()
    const row = body.patients.find((p: { id: string }) => p.id === LEAK_TEST_ID)
    expect(row).toBeDefined()
    expect(row.mfaEnabled).toBe(true)
    for (const p of body.patients) expect(p).not.toHaveProperty('mfaSecretEncrypted')
    expect(JSON.stringify(body)).not.toContain('enc-secret-that-must-not-leak')
  })
})

// SP1 registration shape (patientRegistrationSchema). Aadhaar is declined so
// no encryption key is needed; ABHA is recorded as unavailable.
const registration = (over: Record<string, unknown> = {}) => ({
  name: 'Test Patient', dob: '1990-01-01', gender: 'female', addressLine1: '12 MG Road', city: 'Mumbai', district: 'Mumbai',
  stateCode: 'IN-MH', pinCode: '400001',
  aadhaar: { status: 'declined', reason: 'patient_declined' },
  abha: { status: 'unavailable', reason: 'not_created' },
  ...over,
})

describe('POST /api/patients', () => {
  // Every successful create leaves a real patient (plus its Aadhaar row and
  // audit entries) in the shared dev DB, so track and delete it -- children
  // first -- same pattern as the other write-path tests that mutate real
  // seeded state.
  const createdIds: string[] = []
  afterEach(async () => {
    while (createdIds.length > 0) {
      const id = createdIds.pop()!
      await getDb().delete(auditLog).where(and(eq(auditLog.patientId, id), eq(auditLog.userName, 'Test frontdesk')))
      await getDb().delete(patientAadhaar).where(eq(patientAadhaar.patientId, id))
      await getDb().delete(patients).where(eq(patients.id, id))
    }
  })

  function req(body: unknown) {
    return new NextRequest('http://localhost/api/patients', { method: 'POST', body: JSON.stringify(body) })
  }

  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const response = await createPatient(req(registration()))
    expect(response.status).toBe(401)
  })

  it('rejects a payload missing the required name or DOB', async () => {
    const body: Record<string, unknown> = registration(); delete body.dob
    const response = await createPatient(req(body))
    expect(response.status).toBe(400)
  })

  it('rejects a payload with an unexpected extra field', async () => {
    const response = await createPatient(req(registration({ ssn: '123-45-6789' })))
    expect(response.status).toBe(400)
  })

  it('rejects a pi session -- patient creation is admin/frontdesk exclusively', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI', userId: null })
    const response = await createPatient(req(registration()))
    expect(response.status).toBe(403)
  })

  it('rejects a crc session -- registration moved to front desk exclusively (admin kept as override)', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC', userId: null })
    const response = await createPatient(req(registration()))
    expect(response.status).toBe(403)
  })

  it('inserts the submitted demographics directly into a new patient row and returns only {id, uhid}', async () => {
    const response = await createPatient(req(registration({
      email: 'test.patient@example.com',
      phone: '9876543210',
      city: 'Pune',
      currentProvider: 'Dr. Kunam',
    })))
    expect(response.status).toBe(201)
    const body = await response.json()
    createdIds.push(body.id)
    expect(body.id).toMatch(/^RD-\d{4}$/)
    expect(Object.keys(body).sort()).toEqual(['id', 'uhid'])
    // Single-sourced fields, set directly from the request body -- no
    // Tebra/IntakeQ mirroring or mock side effect.
    const [row] = await getDb().select().from(patients).where(eq(patients.id, body.id))
    expect(row.uhid).toBe(body.uhid)
    expect(row.name).toBe('Test Patient')
    expect(row.dob).toBe('1990-01-01')
    expect(row.email).toBe('test.patient@example.com')
    expect(row.phone).toBe('+919876543210')
    expect(row.city).toBe('Pune')
    expect(row.pinCode).toBe('400001')
    expect(row.zip).toBeNull()
    expect(row.currentProvider).toBe('Dr. Kunam')
  })
})

describe('DELETE /api/patients/[anonId]', () => {
  // Registration writes audit rows (as 'Test Admin') that the DELETE route
  // does not remove; delete exactly those, by patient id and userName.
  const auditedIds: string[] = []
  afterEach(async () => {
    while (auditedIds.length > 0) {
      await getDb().delete(auditLog).where(and(eq(auditLog.patientId, auditedIds.pop()!), eq(auditLog.userName, 'Test Admin')))
    }
  })

  async function createTestPatient(): Promise<string> {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'admin', name: 'Test Admin', userId: null })
    const res = await createPatient(new NextRequest('http://localhost/api/patients', { method: 'POST', body: JSON.stringify(registration({ name: 'Delete Route Test', dob: '1993-03-03' })) }))
    expect(res.status).toBe(201)
    const body = await res.json()
    auditedIds.push(body.id)
    return body.id
  }

  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const response = await deletePatientRoute(new NextRequest('http://localhost/api/patients/RD-0001', { method: 'DELETE' }), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(response.status).toBe(401)
  })

  it('rejects a non-admin session -- deleting a chart is an admin-only action', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC', userId: null })
    const response = await deletePatientRoute(new NextRequest('http://localhost/api/patients/RD-0001', { method: 'DELETE' }), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(response.status).toBe(403)
  })

  it('returns 404 for an unknown anonymous id', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'admin', name: 'Test Admin', userId: null })
    const response = await deletePatientRoute(new NextRequest('http://localhost/api/patients/RD-9999/delete-test', { method: 'DELETE' }), { params: Promise.resolve({ anonId: 'RD-9999-delete-test' }) })
    expect(response.status).toBe(404)
  })

  it('permanently removes the patient as an admin', async () => {
    const id = await createTestPatient()
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'admin', name: 'Test Admin', userId: null })
    const response = await deletePatientRoute(new NextRequest(`http://localhost/api/patients/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ anonId: id }) })
    expect(response.status).toBe(200)

    const [row] = await getDb().select().from(patients).where(eq(patients.id, id))
    expect(row).toBeUndefined()
    // deletePatient() clears 17 tables as separate sequential round-trips
    // (see its own comment on why none of these FKs cascade at the DB
    // level) -- slower than a single-query test even with nothing to
    // delete in most of them, so this needs more than the default 5s.
  }, 15000)

  // SP4: tax records must be kept, so a patient with a receipt cannot be deleted.
  it('409s a patient with issued bills or receipts and deletes nothing', async () => {
    const id = await createTestPatient()
    const { patientPayments } = await import('@/db/schema')
    const { purgeBillingFixtures } = await import('../db/billing-fixtures')
    await getDb().insert(patientPayments).values({
      receiptNumber: `RCT/99-00/DEL-${id}`, kind: 'advance', patientId: id, mode: 'cash', amountPaise: 100, financialYear: '2099-00', receiptDate: '2099-06-01', receivedByName: 'Test Admin',
    })
    try {
      vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'admin', name: 'Test Admin', userId: null })
      const response = await deletePatientRoute(new NextRequest(`http://localhost/api/patients/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ anonId: id }) })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'This patient has issued bills or receipts, which must be kept; the patient cannot be deleted' })
      expect(await getDb().select().from(patients).where(eq(patients.id, id))).toHaveLength(1)
    } finally {
      await purgeBillingFixtures([id])
      const { deletePatient } = await import('@/lib/queries/patients')
      await deletePatient(id)
    }
  }, 15000)
})
