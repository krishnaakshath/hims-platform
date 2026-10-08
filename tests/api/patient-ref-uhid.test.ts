import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, doctorAssignments, encounters, patients, providers } from '@/db/schema'

// Wave C: the check-in and pharmacy routes also accept a UHID typed directly
// (case-insensitive), resolving it to the chart id. Fixture by id
// (TEST_WC_ prefix); audit rows by this file's unique probe userName.
const PID = 'TEST_WC_REF1'
const UHID = 'TWCREF0001'
const PROBE = `TEST_WC_PROBE_REF_${Date.now()}`
let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))

import { POST as checkIn } from '@/app/api/front-desk/check-in/route'
import { GET as pharmacyView } from '@/app/api/pharmacy/patients/[patientId]/route'

async function cleanup() {
  const db = getDb()
  await db.delete(encounters).where(eq(encounters.patientId, PID))
  await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, PID))
  await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  await db.delete(patients).where(eq(patients.id, PID))
}

let providerId: number
beforeAll(async () => {
  await cleanup()
  await getDb().insert(patients).values({ id: PID, name: 'Ref Testwc', dob: '1990-01-01', uhid: UHID })
  const [p] = await getDb().select({ id: providers.id }).from(providers).limit(1)
  providerId = p.id
})
afterAll(cleanup)

describe('UHID accepted directly', () => {
  it('checks in by UHID (any case) and records the chart id', async () => {
    role = 'frontdesk'
    const res = await checkIn(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: UHID.toLowerCase(), providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Review' }) }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.patientId).toBe(PID)
    const [enc] = await getDb().select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, body.encounterId))
    expect(enc.patientId).toBe(PID)
  })

  it('pharmacy looks up by UHID', async () => {
    role = 'pharmacy'
    const res = await pharmacyView(new Request('http://localhost') as never, { params: Promise.resolve({ patientId: ` ${UHID.toLowerCase()} ` }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: PID, uhid: UHID })
  })

  it('still 404s an unknown reference', async () => {
    role = 'frontdesk'
    const res = await checkIn(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'TWCREF-NOPE', providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Review' }) }) as never)
    expect(res.status).toBe(404)
  })
})
