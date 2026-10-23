// WS1 T5: POST /api/encounters/[id]/complete (spec ruling 4: diagnosis before completion) and the
// same guard on POST /api/encounters/[id]/status with to:'completed'. Real worktree DB; session
// and the doctor's provider resolver are mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, diagnoses, encounterConsults, encounterNotes, encounterVitals, encounters, patients, providers } from '@/db/schema'

let role = 'pi'
let actingProvider: { id: number; name: string } | null = null
const PROBE = `TEST_WS1T5C-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postComplete } from '@/app/api/encounters/[id]/complete/route'
import { POST as postStatus } from '@/app/api/encounters/[id]/status/route'
import { completeEncounter } from '@/lib/queries/encounter-workspace'

const PATIENT = `TWS1T5C-${Date.now()}`
const REASON = 'Review visit only, SECRET-REASON-TEXT'
const complete = (id: number | string, body?: unknown) =>
  postComplete(new NextRequest(`http://localhost/api/encounters/${id}/complete`, {
    method: 'POST', ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { params: Promise.resolve({ id: String(id) }) })
const status = (id: number, body: unknown) =>
  postStatus(new NextRequest(`http://localhost/api/encounters/${id}/status`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('completing a visit (DB)', () => {
  let providerA = 0
  let providerB = 0
  const ids: number[] = []
  const mk = async (opts: { providerId?: number; type?: 'opd' | 'ipd' | 'lab'; status?: 'checked_in' | 'in_consultation' | 'completed' } = {}) => {
    const [e] = await getDb().insert(encounters).values({
      patientId: PATIENT, encounterType: opts.type ?? 'opd', encounterDate: '2026-10-01', providerId: opts.providerId ?? providerA,
      status: opts.status ?? 'in_consultation', checkedInByName: PROBE,
    }).returning()
    ids.push(e.id)
    return e.id
  }
  const addDiagnosis = async (encounterId: number, voided = false) => {
    await getDb().insert(diagnoses).values({
      patientId: PATIENT, encounterId, code: '', description: 'Viral fever', codingStatus: 'uncoded', diagnosisType: 'primary',
      ...(voided ? { voidedAt: new Date(), voidedByName: PROBE, diagnosisType: null } : {}),
    })
  }
  const statusOf = async (id: number) => (await getDb().select({ s: encounters.status }).from(encounters).where(eq(encounters.id, id)))[0]?.s

  beforeAll(async () => {
    const db = getDb()
    const [a] = await db.insert(providers).values({ name: `${PROBE} Dr A`, specialty: 'Test', colorTag: '#000000' }).returning()
    const [b] = await db.insert(providers).values({ name: `${PROBE} Dr B`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerA = a.id
    providerB = b.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS1T5 Complete', dob: '1980-01-01', gender: 'female', uhid: `${PATIENT}-UH` })
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(encounterNotes).where(eq(encounterNotes.patientId, PATIENT))
    await db.delete(encounterVitals).where(eq(encounterVitals.patientId, PATIENT))
    await db.delete(encounterConsults).where(eq(encounterConsults.patientId, PATIENT))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    if (ids.length) await db.delete(encounters).where(inArray(encounters.id, ids))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerA, providerB]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => {
    role = 'pi'
    actingProvider = { id: providerA, name: 'Dr A' }
  })

  it('an OPD visit with no live diagnosis and no reason is 409 diagnosis_missing; status unchanged', async () => {
    const id = await mk()
    await addDiagnosis(id, true) // a voided diagnosis does not count
    const res = await complete(id, {})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Add a diagnosis or give a reason before completing the visit.', code: 'diagnosis_missing' })
    expect(await statusOf(id)).toBe('in_consultation')
    // No body at all is the same request.
    expect((await complete(id)).status).toBe(409)
  })

  it('with a reason: 200 completed, the reason stored on the consult, the audit has no reason text', async () => {
    const id = await mk()
    const res = await complete(id, { noDiagnosisReason: REASON })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.encounter).toMatchObject({ id, status: 'completed' })
    expect(JSON.stringify(body)).not.toContain('SECRET-REASON-TEXT')
    expect(await statusOf(id)).toBe('completed')
    const [consult] = await getDb().select().from(encounterConsults).where(eq(encounterConsults.encounterId, id))
    expect(consult.noDiagnosisReason).toBe(REASON)
    const audit = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    const mine = audit.filter((r) => r.details?.includes(`encounter=${id}`))
    expect(mine.map((r) => r.action)).toEqual(expect.arrayContaining(['recorded no-diagnosis reason', 'encounter status changed to completed']))
    expect(JSON.stringify(audit)).not.toContain('SECRET-REASON-TEXT')
  })

  it('a reason outside 5..300 characters or an unknown key is 400', async () => {
    const id = await mk()
    expect((await complete(id, { noDiagnosisReason: 'abc ' })).status).toBe(400)
    expect((await complete(id, { noDiagnosisReason: 'x'.repeat(301) })).status).toBe(400)
    expect((await complete(id, { to: 'completed' })).status).toBe(400)
    expect((await complete(id, '{nope')).status).toBe(400)
    expect(await statusOf(id)).toBe('in_consultation')
  })

  it('with a diagnosis: 200, and warns no_vitals and unsigned_notes', async () => {
    const id = await mk()
    await addDiagnosis(id)
    await getDb().insert(encounterNotes).values({ patientId: PATIENT, encounterId: id, noteType: 'progress', authorName: PROBE, authorRole: 'pi' })
    const res = await complete(id, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.encounter).toMatchObject({ id, status: 'completed' })
    expect(body.warnings).toEqual(['no_vitals', 'unsigned_notes'])
    expect(body.charges).toEqual([]) // WS2 T14: a visit with no department owes no consultation
  })

  it('no warnings when vitals are recorded and no draft note is linked', async () => {
    const id = await mk()
    await addDiagnosis(id)
    await getDb().insert(encounterVitals).values({ encounterId: id, patientId: PATIENT, recordedByName: PROBE, pulseBpm: 80 })
    const res = await complete(id, {})
    expect(res.status).toBe(200)
    expect((await res.json()).warnings).toEqual([])
  })

  it('another doctor\'s visit is 403 not_owner and nothing is stored', async () => {
    const id = await mk({ providerId: providerB })
    const res = await complete(id, { noDiagnosisReason: REASON })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
    expect(await statusOf(id)).toBe('in_consultation')
    expect(await getDb().select().from(encounterConsults).where(eq(encounterConsults.encounterId, id))).toEqual([])
  })

  it('crc, frontdesk and billing are 403 before the body is read', async () => {
    const id = await mk()
    for (const r of ['crc', 'frontdesk', 'billing']) {
      role = r
      const res = await complete(id, '{nope')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
  })

  it('a closed visit is 409 visit_closed; unknown is 404; admin may complete any visit', async () => {
    const done = await mk({ status: 'completed' })
    const closed = await complete(done, { noDiagnosisReason: REASON })
    expect(closed.status).toBe(409)
    expect((await closed.json()).code).toBe('visit_closed')
    role = 'admin'
    actingProvider = null
    expect((await complete(2147483000, {})).status).toBe(404)
    const other = await mk({ providerId: providerB })
    await addDiagnosis(other)
    expect((await complete(other, {})).status).toBe(200)
  })

  it('fix round 1: completeEncounter does not trust a null actingProviderId for a non-admin', async () => {
    const id = await mk({ providerId: providerB })
    await addDiagnosis(id)
    const asPi = await completeEncounter(id, { role: 'pi', name: PROBE, userId: null }, { actingProviderId: null })
    expect(asPi).toEqual({ ok: false, error: 'not_owner' })
    expect(await statusOf(id)).toBe('in_consultation')
    const asAdmin = await completeEncounter(id, { role: 'admin', name: PROBE, userId: null }, { actingProviderId: null })
    expect(asAdmin.ok).toBe(true)
  })

  it('IPD and lab encounters are not guarded', async () => {
    for (const type of ['ipd', 'lab'] as const) {
      const id = await mk({ type })
      const res = await complete(id, {})
      expect(res.status).toBe(200)
      expect(await statusOf(id)).toBe('completed')
    }
  })

  it('the status route applies the same guard to to:"completed" on an OPD visit', async () => {
    const id = await mk()
    const refused = await status(id, { to: 'completed' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'Add a diagnosis or give a reason before completing the visit.', code: 'diagnosis_missing' })
    expect(await statusOf(id)).toBe('in_consultation')
    await addDiagnosis(id)
    const ok = await status(id, { to: 'completed' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).encounter).toMatchObject({ id, status: 'completed' })
  })
})
