import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, ne, and, like, or } from 'drizzle-orm'
import { POST } from '@/app/api/inpatient/admissions/[id]/discharge/route'
import { getDb } from '@/db/client'
import { admissions, patients, appointments, providers, signatures, auditLog, followUpOrders } from '@/db/schema'
import { createAdmission } from '@/lib/queries/admissions'

let sessionRole: 'admin' | 'pi' | 'frontdesk' = 'pi'
let sessionName = 'Dr. Chen'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName, userId: null })) }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Chen', credentials: null, specialty: 'Internal Medicine', colorTag: '#000', isActive: true }]) }))

const createdAdmissionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  sessionName = 'Dr. Chen'
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
  while (createdAdmissionIds.length > 0) {
    const admissionId = createdAdmissionIds.pop()!
    // SP3: the discharge may have created a follow-up order (and its booked
    // appointment) plus in-transaction and notifier audit rows; remove them by id.
    const db = getDb()
    const orders = await db.select({ id: followUpOrders.id }).from(followUpOrders).where(eq(followUpOrders.originatingAdmissionId, admissionId))
    const [adm] = await db.select({ followUpAppointmentId: admissions.followUpAppointmentId }).from(admissions).where(eq(admissions.id, admissionId))
    await db.delete(followUpOrders).where(eq(followUpOrders.originatingAdmissionId, admissionId))
    await db.delete(auditLog).where(or(
      and(eq(auditLog.action, 'discharged patient'), eq(auditLog.details, `admission=${admissionId}`)),
      ...orders.map((o) => like(auditLog.details, `followUp=${o.id} %`)),
    ))
    await db.delete(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, admissionId)))
    await db.delete(admissions).where(eq(admissions.id, admissionId))
    if (adm?.followUpAppointmentId) await db.delete(appointments).where(eq(appointments.id, adm.followUpAppointmentId))
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
  // ---------------------------------------------------------------------------
  // SP3 Task 10
  // ---------------------------------------------------------------------------
  const FIVE = { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', typedName: 'Dr. Chen' }
  const post = (admissionId: number, body: unknown) => POST(new Request('http://localhost', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never, { params: Promise.resolve({ id: String(admissionId) }) })
  async function admitOnProvider1() {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)
    return admission
  }

  it('returns followUpOrderId and 400s a past plan date', async () => {
    const ok = await admitOnProvider1()
    const res = await post(ok.id, { ...FIVE, followUp: { timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'Wound check', planNotes: 'TEST_SP3 plan' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.followUpAppointmentId).toBeNull()
    expect(typeof body.followUpOrderId).toBe('number')
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, body.followUpOrderId))
    expect(o).toMatchObject({ source: 'discharge', status: 'planned', originatingAdmissionId: ok.id })
    // The log-only notice ran after commit (ids only).
    const notices = await getDb().select().from(auditLog).where(eq(auditLog.details, `followUp=${o.id} kind=planned delivered=false`))
    expect(notices).toHaveLength(1)

    const past = await admitOnProvider1()
    const res400 = await post(past.id, { ...FIVE, followUp: { timing: { kind: 'date', dueDate: '2020-01-01' }, reason: 'Wound check' } })
    expect(res400.status).toBe(400)
    expect(await res400.json()).toEqual({ error: 'The follow-up date cannot be in the past.' })
    const [after] = await getDb().select().from(admissions).where(eq(admissions.id, past.id))
    expect(after.status).toBe('admitted')
  })

  it('responds followUpOrderId: null when no follow-up is given', async () => {
    const adm = await admitOnProvider1()
    const res = await post(adm.id, FIVE)
    expect(await res.json()).toEqual({ ok: true, followUpAppointmentId: null, followUpOrderId: null })
  })

  it('a slot creates a scheduled order linked to the booked appointment', async () => {
    const adm = await admitOnProvider1()
    // A minute-aligned slot 400 days out keeps clear of seeded appointments.
    const start = new Date(Math.floor((Date.now() + 400 * 86400000) / 60000) * 60000 + 17 * 60000)
    const end = new Date(start.getTime() + 30 * 60000)
    const res = await post(adm.id, { ...FIVE, followUpStartsAt: start.toISOString(), followUpEndsAt: end.toISOString() })
    expect(res.status).toBe(200)
    const body = await res.json()
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, body.followUpOrderId))
    expect(o).toMatchObject({ status: 'scheduled', appointmentId: body.followUpAppointmentId })
    const notices = await getDb().select().from(auditLog).where(eq(auditLog.details, `followUp=${o.id} kind=booked delivered=false`))
    expect(notices).toHaveLength(1)
  })

  it('rejects a slot without an explicit UTC offset with a fixed 400 that does not echo input', async () => {
    const adm = await admitOnProvider1()
    const res = await post(adm.id, { ...FIVE, followUpStartsAt: '2099-10-21T10:00:00', followUpEndsAt: '2099-10-21T10:30:00' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'Invalid discharge payload' })
    expect(text).not.toContain('2099')
    const [after] = await getDb().select().from(admissions).where(eq(admissions.id, adm.id))
    expect(after.status).toBe('admitted')
  })

  it('rejects a slot with only one end', async () => {
    const adm = await admitOnProvider1()
    const res = await post(adm.id, { ...FIVE, followUpStartsAt: '2099-10-21T10:00:00+05:30' })
    expect(res.status).toBe(400)
  })

  it('400s a body that is not JSON', async () => {
    const adm = await admitOnProvider1()
    const res = await post(adm.id, '{not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('403s frontdesk before reading the body', async () => {
    sessionRole = 'frontdesk' as typeof sessionRole
    const adm = await admitOnProvider1()
    const res = await post(adm.id, '{not json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('maps a deadlock / serialization failure to 409 try again', async () => {
    const adm = await admitOnProvider1()
    vi.doMock('@/lib/queries/admissions', async () => {
      const actual = await vi.importActual<typeof import('@/lib/queries/admissions')>('@/lib/queries/admissions')
      return { ...actual, dischargeAdmission: vi.fn(async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }) }) }
    })
    vi.resetModules()
    try {
      const { POST: postDeadlock } = await import('@/app/api/inpatient/admissions/[id]/discharge/route')
      const res = await postDeadlock(new Request('http://localhost', { method: 'POST', body: JSON.stringify(FIVE) }) as never, { params: Promise.resolve({ id: String(adm.id) }) })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/try again/i)
      expect(JSON.stringify(body)).not.toMatch(/deadlock/)
    } finally {
      vi.doUnmock('@/lib/queries/admissions')
      vi.resetModules()
    }
  })
})
