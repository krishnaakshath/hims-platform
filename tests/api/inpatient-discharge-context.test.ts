// WS3 T6: GET /api/inpatient/admissions/[id]/discharge-context (spec 3.2 item 14). DISCHARGE_ROLES;
// a pi sees only the stays they attend, exactly like the discharge route.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, ne } from 'drizzle-orm'
import { GET } from '@/app/api/inpatient/admissions/[id]/discharge-context/route'
import { getDb } from '@/db/client'
import { admissions, auditLog, medicationAdministrations, patients, providers } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'frontdesk' = 'pi'
let sessionName = 'Dr. Chen'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName, userId: null })) }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Chen', credentials: null, specialty: 'Internal Medicine', colorTag: '#000', isActive: true }]) }))

const get = (id: number | string) => GET(new Request(`http://localhost/api/inpatient/admissions/${id}/discharge-context`) as never, { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('GET /api/inpatient/admissions/[id]/discharge-context', () => {
  const RUN = `${Date.now() % 1e8}${Math.floor(Math.random() * 1e3)}`
  const PID = `TEST-WS3T6-RCTX-${RUN}`
  let ownAdmission = 0
  let otherAdmission = 0

  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS3T6 Route Patient', dob: '1985-01-01', gender: 'female' })
    const [other] = await db.select({ id: providers.id }).from(providers).where(ne(providers.id, 1)).limit(1)
    const [own] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: 1, status: 'discharged', dischargedAt: new Date() }).returning()
    const [theirs] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: other.id }).returning()
    ownAdmission = own.id
    otherAdmission = theirs.id
    await db.insert(medicationAdministrations).values({ admissionId: ownAdmission, medicationName: 'Paracetamol', dose: '650 mg', scheduledFor: new Date(Date.now() - 3_600_000), status: 'given' })
  })

  afterEach(() => { sessionRole = 'pi'; sessionName = 'Dr. Chen' })

  afterAll(async () => {
    const db = getDb()
    await db.delete(medicationAdministrations).where(eq(medicationAdministrations.admissionId, ownAdmission))
    await db.delete(admissions).where(eq(admissions.patientId, PID))
    await db.delete(auditLog).where(eq(auditLog.patientId, PID))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  it('403 for the front desk', async () => {
    sessionRole = 'frontdesk'
    sessionName = 'Front Desk'
    const res = await get(ownAdmission)
    expect(res.status).toBe(403)
  })

  it("403 for a pi on another doctor's patient", async () => {
    const res = await get(otherAdmission)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('400 on a bad id, 404 on an unknown admission', async () => {
    expect((await get('abc')).status).toBe(400)
    expect((await get(2_147_483_000)).status).toBe(404)
  })

  it('200 with the context for the attending pi, audited with ids only', async () => {
    const res = await get(ownAdmission)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.medications).toEqual([{ name: 'Paracetamol', dose: '650 mg', lastStatus: 'given' }])
    expect(body.dues).toMatchObject({ outstandingPaise: 0 })
    expect(body).toHaveProperty('diagnoses')
    expect(body).toHaveProperty('latestClearance', null)
    expect(body).toHaveProperty('unpostedRoomRentDays')
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, PID), eq(auditLog.action, 'viewed discharge context')))
    expect(audits.map((a) => a.details)).toEqual([`admission=${ownAdmission}`])
  })

  it('an admin sees any stay', async () => {
    sessionRole = 'admin'
    sessionName = 'Admin User'
    expect((await get(otherAdmission)).status).toBe(200)
  })
})
