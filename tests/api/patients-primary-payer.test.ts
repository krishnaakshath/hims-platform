import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/patients/[anonId]/primary-payer/route'
import { getDb } from '@/db/client'
import { patients, payers } from '@/db/schema'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'billing'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }))

// Throwaway patient created and deleted by explicit id -- never a real chart.
// Name/DOB/contact values are distinctive so a leak would be detectable.
const TEST_PATIENT_ID = 'RD-PAYER-LOOKUP-TEST'
let payerId: number

beforeAll(async () => {
  const [payer] = await getDb().select({ id: payers.id }).from(payers).limit(1)
  payerId = payer.id
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
  await getDb().insert(patients).values({
    id: TEST_PATIENT_ID, name: 'Payer Lookup Leakcheck', dob: '1977-07-07',
    email: 'payer-leakcheck@example.test', phone: '555-0177', primaryPayerId: payerId, primaryMemberId: 'MEMBER-LEAKCHECK',
  })
})

afterAll(async () => {
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

afterEach(() => {
  sessionRole = 'billing'
})

const call = (anonId: string) =>
  GET(new NextRequest(`http://localhost/api/patients/${anonId}/primary-payer`), { params: Promise.resolve({ anonId }) })

describe('GET /api/patients/[anonId]/primary-payer', () => {
  it('returns exactly { primaryPayerId } for admin, crc and billing', async () => {
    for (const role of ['admin', 'crc', 'billing'] as const) {
      sessionRole = role
      const res = await call(TEST_PATIENT_ID)
      expect(res.status, `role ${role}`).toBe(200)
      expect(res.headers.get('cache-control'), `role ${role}`).toBe('no-store')
      const text = await res.text()
      const body = JSON.parse(text)
      expect(Object.keys(body)).toEqual(['primaryPayerId'])
      expect(body).toEqual({ primaryPayerId: payerId })
      for (const leak of ['Leakcheck', '1977-07-07', 'payer-leakcheck', '555-0177', 'MEMBER-LEAKCHECK']) {
        expect(text, `role ${role} must not leak ${leak}`).not.toContain(leak)
      }
    }
  })

  it('returns { primaryPayerId: null } for a self-pay patient', async () => {
    await getDb().update(patients).set({ primaryPayerId: null }).where(eq(patients.id, TEST_PATIENT_ID))
    try {
      const res = await call(TEST_PATIENT_ID)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ primaryPayerId: null })
    } finally {
      await getDb().update(patients).set({ primaryPayerId: payerId }).where(eq(patients.id, TEST_PATIENT_ID))
    }
  })

  it('403s frontdesk, pi, pharmacy and labs with no data in the body', async () => {
    for (const role of ['frontdesk', 'pi', 'pharmacy', 'labs', 'collector'] as const) {
      sessionRole = role
      const res = await call(TEST_PATIENT_ID)
      expect(res.status, `role ${role}`).toBe(403)
      expect(await res.json(), `body for ${role}`).toEqual({ error: 'Forbidden' })
    }
  })

  it('404s an unknown patient with the generic sibling shape', async () => {
    const res = await call('RD-ZZZZ')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})
