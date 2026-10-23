// WS1 T4: POST /api/encounters/[id]/referrals and the "Referred to me" list, against the worktree
// test DB. Session and the doctor's provider resolver are mocked; everything else is real.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, departments, encounters, patients, providers, referrals } from '@/db/schema'

let role = 'admin'
let actingProvider: { id: number; name: string } | null = null
const PROBE = `TEST_WS1T4R-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postReferral } from '@/app/api/encounters/[id]/referrals/route'
import { listOpenReferralsToProvider } from '@/lib/queries/referrals'

const RUN = `${Date.now()}`.slice(-7)
const PATIENT = `TWS1T4R-${RUN}`
const SECRET_REASON = 'SECRET-REFERRAL-REASON for cardiology review'

const post = (id: number, body: unknown) =>
  postReferral(new NextRequest(`http://localhost/api/encounters/${id}/referrals`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('encounter referrals route (DB)', () => {
  let providerA = 0
  let providerB = 0
  let providerC = 0 // in the department, not named
  let departmentId = 0
  let openA = 0
  let openB = 0
  let doneA = 0
  const encounterIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: `T4${RUN}`, name: `${PROBE} Cardiology` }).returning()
    departmentId = d.id
    const mkProvider = async (n: string, dept: number | null) =>
      (await db.insert(providers).values({ name: `${PROBE} ${n}`, specialty: 'Test', colorTag: '#000000', departmentId: dept }).returning())[0].id
    providerA = await mkProvider('Dr A', null)
    providerB = await mkProvider('Dr B', null)
    providerC = await mkProvider('Dr C', departmentId)
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS1T4R Patient', dob: '1980-01-01', gender: 'male', uhid: `${PATIENT}-UH` })
    const mk = async (providerId: number, status: 'in_consultation' | 'completed') => {
      const [e] = await db.insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status, checkedInByName: PROBE }).returning()
      encounterIds.push(e.id)
      return e.id
    }
    openA = await mk(providerA, 'in_consultation')
    openB = await mk(providerB, 'in_consultation')
    doneA = await mk(providerA, 'completed')
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(referrals).where(eq(referrals.patientId, PATIENT))
    await db.delete(encounters).where(inArray(encounters.id, encounterIds))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerA, providerB, providerC]))
    await db.delete(departments).where(eq(departments.id, departmentId))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => {
    role = 'admin'
    actingProvider = null
  })

  it('an internal referral without a department or doctor is 400', async () => {
    expect((await post(openA, { kind: 'internal', reason: SECRET_REASON, urgency: 'routine' })).status).toBe(400)
    expect((await post(openA, { kind: 'external', reason: SECRET_REASON, urgency: 'routine' })).status).toBe(400)
    expect((await post(openA, { kind: 'internal', toProviderId: providerB, reason: 'x', urgency: 'routine' })).status).toBe(400)
  })

  it('an external referral is 201 and stored open', async () => {
    const res = await post(openA, { kind: 'external', externalFacility: 'City Heart Centre', externalDoctor: 'Dr Rao', reason: SECRET_REASON, urgency: 'urgent' })
    expect(res.status).toBe(201)
    const { referral } = await res.json()
    expect(referral).toMatchObject({ encounterId: openA, patientId: PATIENT, kind: 'external', externalFacility: 'City Heart Centre', status: 'open', createdByName: PROBE, urgency: 'urgent' })
  })

  it('an internal referral to a doctor appears in that doctor\'s "Referred to me" list', async () => {
    const res = await post(openA, { kind: 'internal', toProviderId: providerB, reason: SECRET_REASON, urgency: 'emergency' })
    expect(res.status).toBe(201)
    const { referral } = await res.json()
    const list = await listOpenReferralsToProvider(providerB, null)
    const mine = list.find((r) => r.id === referral.id)
    expect(mine).toMatchObject({ patientId: PATIENT, patientName: 'TEST_WS1T4R Patient', uhid: `${PATIENT}-UH`, fromProviderName: `${PROBE} Dr A`, urgency: 'emergency' })
    expect((await listOpenReferralsToProvider(providerC, departmentId)).map((r) => r.id)).not.toContain(referral.id)
  })

  it('a department referral reaches the department\'s doctors', async () => {
    const res = await post(openA, { kind: 'internal', toDepartmentId: departmentId, reason: SECRET_REASON, urgency: 'routine' })
    const { referral } = await res.json()
    expect((await listOpenReferralsToProvider(providerC, departmentId)).map((r) => r.id)).toContain(referral.id)
    expect((await listOpenReferralsToProvider(providerB, null)).map((r) => r.id)).not.toContain(referral.id)
  })

  it('an unknown department or doctor is 400', async () => {
    expect((await post(openA, { kind: 'internal', toProviderId: 2147483000, reason: SECRET_REASON, urgency: 'routine' })).status).toBe(400)
    expect((await post(openA, { kind: 'internal', toDepartmentId: 2147483000, reason: SECRET_REASON, urgency: 'routine' })).status).toBe(400)
  })

  it('pi refers only from their own open visit; crc is 403; a closed visit is 409', async () => {
    role = 'pi'
    actingProvider = { id: providerA, name: 'Dr A' }
    const body = { kind: 'external', externalFacility: 'City Heart Centre', reason: SECRET_REASON, urgency: 'routine' }
    expect((await post(openA, body)).status).toBe(201)
    const other = await post(openB, body)
    expect(other.status).toBe(403)
    expect((await other.json()).code).toBe('not_owner')
    expect((await post(doneA, body)).status).toBe(409)
    role = 'crc'
    expect((await post(openA, body)).status).toBe(403)
  })

  it('audit rows carry ids only, never the reason or the facility', async () => {
    const rows = (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))).filter((r) => r.action === 'created referral')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.details).toMatch(/^encounter=\d+ referral=\d+ kind=(internal|external) urgency=\w+$/)
      expect(r.details).not.toContain('SECRET')
      expect(r.details).not.toContain('Heart')
      expect(r.patientId).toBe(PATIENT)
    }
  })
})
