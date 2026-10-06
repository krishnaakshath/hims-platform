import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, ne, and } from 'drizzle-orm'
import { POST } from '@/app/api/inpatient/admissions/[id]/discharge/route'
import { getDb } from '@/db/client'
import { admissions, patients, appointments, providers, signatures } from '@/db/schema'
import { createAdmission } from '@/lib/queries/admissions'

let sessionRole: 'admin' | 'pi' | 'frontdesk' = 'pi'
let sessionName = 'Dr. Chen'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Chen', credentials: null, specialty: 'Internal Medicine', colorTag: '#000', isActive: true }]) }))

const createdAdmissionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  sessionName = 'Dr. Chen'
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
  while (createdAdmissionIds.length > 0) {
    const admissionId = createdAdmissionIds.pop()!
    await getDb().delete(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, admissionId)))
    await getDb().delete(admissions).where(eq(admissions.id, admissionId))
  }
})

describe('POST /api/inpatient/admissions/[id]/discharge', () => {
  it('rejects a discharge missing a required field', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: '', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(400)
  })

  it('rejects a discharge missing typedName', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(400)
  })

  it('discharges successfully with all five fields present, no follow-up', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)
  })

  it('inserts a signature row alongside a successful discharge', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)

    const rows = await getDb().select().from(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, admission.id)))
    expect(rows).toHaveLength(1)
    expect(rows[0].signerTypedName).toBe('Dr. Chen')
  })

  it('rejects a non-admin signer typing a name that does not match their own session name', async () => {
    // Mirrors signNote's exact posture (encounter-notes.ts): typedName must
    // match the authenticated signer, unless they're an admin.
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Someone Else' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)

    const updated = await getDb().select().from(admissions).where(eq(admissions.id, admission.id))
    expect(updated[0].status).toBe('admitted')
    const rows = await getDb().select().from(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, admission.id)))
    expect(rows).toHaveLength(0)
  })

  it('allows an admin to discharge with a typed name that does not match their own session name (admin override)', async () => {
    sessionRole = 'admin'
    sessionName = 'Admin User'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)

    const updated = await getDb().select().from(admissions).where(eq(admissions.id, admission.id))
    expect(updated[0].status).toBe('discharged')
    const rows = await getDb().select().from(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, admission.id)))
    expect(rows[0].signerTypedName).toBe('Dr. Chen')
  })

  it('rejects a PI discharging an admission they are not the attending provider for', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    // Must be a real providers.id (FK-enforced) that isn't 1 -- `listActiveProviders`
    // is mocked above to return only {id: 1, name: 'Dr. Chen'}, so any other real
    // provider id represents "someone else," which is all this test needs.
    const [otherProviderRow] = await getDb().select().from(providers).where(ne(providers.id, 1)).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: otherProviderRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
  })

  // RBAC Task 18: the old `provider.name.includes(lastName)` check let a pi
  // whose surname is a substring of the attending's ("Che" in "Dr. Chen")
  // pass ownership. Exact-surname matching must deny before any write.
  it('rejects a PI whose surname is only a substring of the attending provider\'s (no fuzzy match)', async () => {
    sessionRole = 'pi'
    sessionName = 'Dr. Che'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Che' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
    const updated = await getDb().select().from(admissions).where(eq(admissions.id, admission.id))
    expect(updated[0].status).toBe('admitted')
  })

  it('rejects discharging an already-discharged admission', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)
    const body = JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' })
    await POST(new Request('http://localhost', { method: 'POST', body }) as never, { params: Promise.resolve({ id: String(admission.id) }) })

    const res = await POST(new Request('http://localhost', { method: 'POST', body }) as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(409)
  })

  it('rejects a follow-up appointment whose end is not after its start', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() - 60 * 1000)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({
      dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen',
      followUpStartsAt: startsAt.toISOString(), followUpEndsAt: endsAt.toISOString(),
    }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(400)

    const updated = await getDb().select().from(admissions).where(eq(admissions.id, admission.id))
    expect(updated[0].status).toBe('admitted')
  })

  it('rejects a follow-up appointment that conflicts with an existing appointment for the same provider', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000)
    const [existingAppt] = await getDb().insert(appointments).values({
      patientId: patientRow.id,
      providerId: 1,
      startsAt,
      endsAt,
      visitReason: 'Pre-existing appointment blocking the follow-up slot',
      status: 'scheduled',
    }).returning()
    createdAppointmentIds.push(existingAppt.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({
      dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen',
      followUpStartsAt: startsAt.toISOString(), followUpEndsAt: endsAt.toISOString(),
    }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(409)

    const updated = await getDb().select().from(admissions).where(eq(admissions.id, admission.id))
    expect(updated[0].status).toBe('admitted')
  })

  it('discharge still succeeds and the admission is still discharged even if recording the signature fails', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    vi.doMock('@/lib/queries/signatures', () => ({
      createSignature: vi.fn(async () => { throw new Error('simulated signature insert failure') }),
    }))
    vi.resetModules()
    const { POST: postWithFailingSignature } = await import('@/app/api/inpatient/admissions/[id]/discharge/route')

    try {
      const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }) })
      const res = await postWithFailingSignature(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      const updated = await getDb().select().from(admissions).where(eq(admissions.id, admission.id))
      expect(updated[0].status).toBe('discharged')

      // Prove the mocked createSignature actually fired (and the route's
      // catch swallowed the throw) rather than this test passing vacuously
      // because vi.doMock silently failed to engage -- no signature row
      // should exist for this admission.
      const rows = await getDb().select().from(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, admission.id)))
      expect(rows).toHaveLength(0)
    } finally {
      vi.doUnmock('@/lib/queries/signatures')
      vi.resetModules()
    }
  })
})
