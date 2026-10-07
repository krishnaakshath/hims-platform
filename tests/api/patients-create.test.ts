import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from '@/app/api/patients/route'
import { getDb } from '@/db/client'
import { patients, auditLog, patientAadhaar, patientContacts, identityVerifications } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { parseUhid } from '@/lib/uhid'

// Registration is admin/frontdesk exclusively -- crc had this removed per
// explicit product direction (route.ts's own comment; see also
// DashboardHomeClient.tsx's canAddPatient and CoordinatorDashboard.tsx:64).
// The session name is a unique probe so cleanup deletes only this file's
// audit rows.
const PROBE_USER = `TEST-SP1-patients-create-${Date.now()}`
let sessionRole: 'admin' | 'frontdesk' | 'crc' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: PROBE_USER })) }))

const registration = (over: Record<string, unknown> = {}) => ({
  name: 'TEST-SP1 Create Client', dob: '1995-05-05', gender: 'male', addressLine1: '4 Park Street', city: 'Kolkata', district: 'Kolkata',
  stateCode: 'IN-WB', pinCode: '700016',
  aadhaar: { status: 'provided', number: '2345 6789 0124', consent: true },
  abha: { status: 'unavailable', reason: 'not_created' },
  ...over,
})
const post = (body: unknown) => POST(new Request('http://localhost/api/patients', { method: 'POST', body: JSON.stringify(body) }) as never)

// The "creates a client" test hits the real POST handler, which really
// inserts a patient (plus its Aadhaar row and audit entries) -- capture
// whatever id it assigns and delete children before the patient afterward.
let createdPatientId: string | undefined

describe.skipIf(!process.env.DATABASE_URL)('POST /api/patients (DB)', () => {
  beforeEach(() => {
    vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    sessionRole = 'frontdesk'
    if (!createdPatientId) return
    const db = getDb()
    await db.delete(auditLog).where(and(eq(auditLog.patientId, createdPatientId), eq(auditLog.userName, PROBE_USER)))
    await db.delete(patientContacts).where(eq(patientContacts.patientId, createdPatientId))
    await db.delete(patientAadhaar).where(eq(patientAadhaar.patientId, createdPatientId))
    await db.delete(identityVerifications).where(eq(identityVerifications.patientId, createdPatientId))
    await db.delete(patients).where(eq(patients.id, createdPatientId))
    createdPatientId = undefined
  })

  it('rejects a payload missing a name', async () => {
    const body: Record<string, unknown> = registration(); delete body.name
    const res = await post(body)
    expect(res.status).toBe(400)
  })

  it('403s crc (registration is admin/frontdesk exclusively)', async () => {
    sessionRole = 'crc'
    const res = await post(registration())
    expect(res.status).toBe(403)
  })

  it('creates a client, assigns the next sequential anon ID and a UHID, and audits without the Aadhaar number', async () => {
    const res = await post(registration())
    expect(res.status).toBe(201)
    const text = await res.text()
    const body = JSON.parse(text)
    createdPatientId = body.id
    expect(Object.keys(body).sort()).toEqual(['id', 'uhid'])
    expect(body.id).toMatch(/^RD-\d{4}$/)
    expect(parseUhid(body.uhid)).not.toBeNull()
    expect(text).not.toMatch(/2345[\s-]*6789[\s-]*0124/)

    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, body.id), eq(auditLog.userName, PROBE_USER)))
    expect(audit.map((a) => a.action).sort()).toEqual(['recorded ABHA unavailable', 'recorded Aadhaar with consent', 'registered patient'])
    expect(JSON.stringify(audit)).not.toMatch(/2345[\s-]*6789[\s-]*0124/)

    const [a] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, body.id))
    expect(a.aadhaarLast4).toBe('0124')
    expect(a.aadhaarEncrypted).not.toContain('234567890124')
  })
})
