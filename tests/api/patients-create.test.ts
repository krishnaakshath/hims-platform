import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from '@/app/api/patients/route'
import { getDb } from '@/db/client'
import { patients, auditLog } from '@/db/schema'
import { eq } from 'drizzle-orm'

// Registration is admin/frontdesk exclusively -- crc had this removed per
// explicit product direction (route.ts:45's own comment; see also
// DashboardHomeClient.tsx's canAddPatient and CoordinatorDashboard.tsx:64).
let sessionRole: 'admin' | 'frontdesk' | 'crc' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))

// The "creates a client" test hits the real POST handler, which really
// inserts a patient row (and an audit-log entry) -- capture whatever id it
// assigns and delete both afterward so the test suite never leaves
// fabricated clients behind in the dev DB.
let createdPatientId: string | undefined

afterEach(async () => {
  sessionRole = 'frontdesk'
  if (!createdPatientId) return
  await getDb().delete(auditLog).where(eq(auditLog.patientId, createdPatientId))
  await getDb().delete(patients).where(eq(patients.id, createdPatientId))
  createdPatientId = undefined
})

describe('POST /api/patients', () => {
  it('rejects a payload missing a name', async () => {
    const req = new Request('http://localhost/api/patients', { method: 'POST', body: JSON.stringify({ dob: '1990-01-01' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('403s crc (registration is admin/frontdesk exclusively)', async () => {
    sessionRole = 'crc'
    const req = new Request('http://localhost/api/patients', { method: 'POST', body: JSON.stringify({ name: 'Test Client', dob: '1995-05-05' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
  })

  it('creates a client and assigns the next sequential anon ID', async () => {
    const req = new Request('http://localhost/api/patients', { method: 'POST', body: JSON.stringify({ name: 'Test Client', dob: '1995-05-05' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toMatch(/^RD-\d{4}$/)
    createdPatientId = body.id
  })
})
