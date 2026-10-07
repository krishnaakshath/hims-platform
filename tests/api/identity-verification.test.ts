import { describe, it, expect, vi, afterEach } from 'vitest'
import { PUT } from '@/app/api/patients/[anonId]/identity/route'
import { getDb } from '@/db/client'
import { patients, identityVerifications, auditLog } from '@/db/schema'
import { eq } from 'drizzle-orm'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'collector' = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz', userId: null })) }))

// The positive-path PUT genuinely writes an identity-verification row (it's
// not mocked), so it must never target a real seeded patient like RD-0004 --
// that would fabricate compliance-looking data on a real chart. Use a
// dedicated throwaway patient instead, and clean up both rows afterward.
const TEST_PATIENT_ID = 'RD-9002'

async function cleanup() {
  await getDb().delete(identityVerifications).where(eq(identityVerifications.patientId, TEST_PATIENT_ID))
  await getDb().delete(auditLog).where(eq(auditLog.patientId, TEST_PATIENT_ID))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
}

afterEach(async () => {
  sessionRole = 'crc'
  await cleanup()
})

describe('PUT /api/patients/[anonId]/identity', () => {
  it('rejects an invalid idType', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'ssn_card', idNumber: '123' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(res.status).toBe(400)
  })

  it('rejects an Aadhaar-shaped idNumber with a fixed message that never echoes it', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'pan', idNumber: '2345 6789 0124' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ anonId: 'RD-0001' }) })
    expect(res.status).toBe(400)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('Do not enter an Aadhaar number in this field')
    expect(text).not.toMatch(/2345|6789|0124/)
  })

  // IDENTITY_VERIFY_ROLES = admin, crc, frontdesk. Denied before the body
  // is parsed or any row is read/written -- a valid payload proves the 403
  // comes from the role gate, not validation.
  it('403s pi, pharmacy, billing, labs', async () => {
    for (const role of ['pi', 'pharmacy', 'billing', 'labs', 'collector'] as const) {
      sessionRole = role
      const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'passport', idNumber: 'P0000001' }) })
      const res = await PUT(req as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
      expect(res.status, `role ${role}`).toBe(403)
      expect(await res.json(), `body for ${role}`).toEqual({ error: 'Forbidden' })
    }
    const rows = await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, TEST_PATIENT_ID))
    expect(rows).toHaveLength(0)
  })

  it('admits frontdesk (check-in identity verification)', async () => {
    sessionRole = 'frontdesk'
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'ssn_card', idNumber: '123' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(400)
  })

  it('marks identity verified for a valid payload', async () => {
    await cleanup()
    await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Test Patient', dob: '1990-01-01' })

    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ idType: 'passport', idNumber: 'P0000001' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ anonId: TEST_PATIENT_ID }) })
    expect(res.status).toBe(200)

    const [row] = await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, TEST_PATIENT_ID))
    expect(row.verified).toBe(true)
  })
})
