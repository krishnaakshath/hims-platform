// WS3 T2: POST /api/inpatient/admissions, the check-in refusal of inpatients, and no token slip for an IPD stay.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, auditLog, diagnoses, doctorAssignments, encounters, patients, providers, rooms } from '@/db/schema'

const state = vi.hoisted(() => ({ role: 'frontdesk' as string, name: '', providerMatch: null as { id: number; name: string } | null }))
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role: state.role, name: state.name, userId: null })),
  requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: state.name, userId: null })),
}))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => state.providerMatch) }))
class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (to: string) => { throw new Error(`redirect ${to}`) },
}))

import { POST } from '@/app/api/inpatient/admissions/route'
import { POST as checkInPost } from '@/app/api/front-desk/check-in/route'
import TokenSlipPage from '@/app/print/token/[encounterId]/page'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST_WS3T2R-${RUN}`
const PATIENT = `TEST-WS3T2R-${RUN}`
const UHID = `UHT2R${RUN}`

const req = (body: unknown) => new Request('http://localhost/api/inpatient/admissions', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never

describe.skipIf(!process.env.DATABASE_URL)('POST /api/inpatient/admissions', () => {
  let providerId = 0
  let otherProviderId = 0
  const roomIds: number[] = []
  async function room() {
    const [r] = await getDb().insert(rooms).values({ ward: `${PROBE} Ward`, roomNumber: `R${roomIds.length}`, bedNumber: 'A' }).returning()
    roomIds.push(r.id)
    return r.id
  }
  const body = (roomId: number, over: Record<string, unknown> = {}) => ({
    patientId: PATIENT, attendingProviderId: providerId, roomId, admissionType: 'elective', reason: 'Planned surgery',
    provisionalDiagnosis: { text: 'Inguinal hernia' }, expectedStayDays: 3, attendant: null, policyId: null, preauthId: null,
    depositRequiredPaise: 0, wardGenderOverrideReason: null, openOpdVisit: null, ...over,
  })

  beforeAll(async () => {
    state.name = PROBE
    const [a] = await getDb().insert(providers).values({ name: `${PROBE} Dr A`, specialty: 'Test', colorTag: '#000000' }).returning()
    const [b] = await getDb().insert(providers).values({ name: `${PROBE} Dr B`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = a.id
    otherProviderId = b.id
    await getDb().insert(patients).values({ id: PATIENT, name: 'TEST_WS3T2 Route', dob: '1970-01-01', gender: 'male', uhid: UHID })
  })

  afterEach(async () => {
    const db = getDb()
    state.role = 'frontdesk'
    state.providerMatch = null
    const admIds = (await db.select({ id: admissions.id }).from(admissions).where(eq(admissions.patientId, PATIENT))).map((r) => r.id)
    if (admIds.length) await db.delete(admissionCoverage).where(inArray(admissionCoverage.admissionId, admIds))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    await db.delete(encounters).where(eq(encounters.patientId, PATIENT))
    await db.delete(admissions).where(eq(admissions.patientId, PATIENT))
    await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, PATIENT))
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  afterAll(async () => {
    await getDb().delete(patients).where(eq(patients.id, PATIENT))
    await getDb().delete(providers).where(inArray(providers.id, [providerId, otherProviderId]))
  })

  it.each(['billing', 'labs'])('403s %s before reading the body', async (role) => {
    state.role = role
    const res = await POST(req('{not json'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('400s an unknown key', async () => {
    const res = await POST(req({ ...body(await room()), notAField: true }))
    expect(res.status).toBe(400)
  })

  it('400s a too-short override reason and a bad attendant phone', async () => {
    const r1 = await room()
    expect((await POST(req(body(r1, { wardGenderOverrideReason: 'short' })))).status).toBe(400)
    expect((await POST(req(body(r1, { attendant: { name: 'A', relationship: 'Son', phone: '12' } })))).status).toBe(400)
  })

  it('a pi admitting under another doctor is 403; as the attending it is 201', async () => {
    state.role = 'pi'
    state.providerMatch = { id: otherProviderId, name: 'B' }
    const r1 = await room()
    expect((await POST(req(body(r1)))).status).toBe(403)
    expect(await getDb().select().from(admissions).where(eq(admissions.patientId, PATIENT))).toHaveLength(0)
    state.providerMatch = { id: providerId, name: 'A' }
    expect((await POST(req(body(r1)))).status).toBe(201)
  })

  it('201 with the UHID and no cash desk link when no deposit is asked', async () => {
    const r1 = await room()
    const res = await POST(req(body(r1)))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json).toMatchObject({ patientId: PATIENT, uhid: UHID, roomLabel: `${PROBE} Ward R0-A`, depositRequiredPaise: 0 })
    expect(json.admissionId).toEqual(expect.any(Number))
    expect(json.encounterId).toEqual(expect.any(Number))
    expect(json).not.toHaveProperty('cashDeskHref')
  })

  it('accepts the UHID as the patient reference and links the cash desk when a deposit is asked', async () => {
    const res = await POST(req(body(await room(), { patientId: UHID.toLowerCase(), depositRequiredPaise: 25_000_00 })))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ patientId: PATIENT, cashDeskHref: `/cash-desk?patientId=${PATIENT}&amountPaise=2500000` })
  })

  it('maps refusals to status and code with fixed messages', async () => {
    const r1 = await room()
    const nope = await POST(req(body(r1, { patientId: 'NOPE-XYZ' })))
    expect(nope.status).toBe(404)
    expect(await nope.json()).toMatchObject({ code: 'patient_not_found' })
    const noDoc = await POST(req(body(r1, { attendingProviderId: 2147483000 })))
    expect(noDoc.status).toBe(404)
    expect(await noDoc.json()).toMatchObject({ code: 'provider_not_found' })
    expect((await POST(req(body(r1)))).status).toBe(201)
    const again = await POST(req(body(await room())))
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: expect.any(String), code: 'already_admitted' })
  })

  it('422s a ward gender conflict with the conflict kind', async () => {
    const [r] = await getDb().insert(rooms).values({ ward: `${PROBE} Ward`, roomNumber: 'F1', bedNumber: 'A', genderRestriction: 'female' }).returning()
    roomIds.push(r.id)
    const res = await POST(req(body(r.id)))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'ward_gender_conflict', conflict: 'opposite_sex' })
  })

  it('409s an open OPD visit with its id', async () => {
    const [e] = await getDb().insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()), providerId, status: 'checked_in', checkedInByName: PROBE }).returning()
    const res = await POST(req(body(await room())))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'open_opd_visit', openEncounterId: e.id })
  })

  it('front-desk check-in refuses an inpatient with use_admission_form', async () => {
    const res = await checkInPost(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: PATIENT, visitType: 'inpatient', urgency: 'routine', reason: 'Admit', providerId }) }) as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'use_admission_form' })
    expect(await getDb().select().from(admissions).where(eq(admissions.patientId, PATIENT))).toHaveLength(0)
  })

  it('/print/token of an IPD encounter is not found', async () => {
    const res = await POST(req(body(await room())))
    const { encounterId } = await res.json()
    await expect(TokenSlipPage({ params: Promise.resolve({ encounterId: String(encounterId) }) })).rejects.toBeInstanceOf(NotFound)
  })
})
