// WS1 T3: allergy list and "no known allergies" status. POST /api/patients/[anonId]/allergies,
// PATCH /api/patients/[anonId]/allergies/[id] (inactivate), PUT /api/patients/[anonId]/allergy-status.
// Real worktree DB; the session is mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { allergies, auditLog, patients } from '@/db/schema'

let role = 'crc'
const PROBE = `TEST_WS1T3A-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))

import { POST as postAllergy } from '@/app/api/patients/[anonId]/allergies/route'
import { PATCH as patchAllergy } from '@/app/api/patients/[anonId]/allergies/[id]/route'
import { PUT as putStatus } from '@/app/api/patients/[anonId]/allergy-status/route'
import { listActiveAllergies } from '@/lib/queries/allergies'

const PATIENT = `TWS1T3A-${Date.now()}`
const OTHER = `TWS1T3B-${Date.now()}`
const req = (method: string, path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const add = (anonId: string, body: unknown) => postAllergy(req('POST', `/api/patients/${anonId}/allergies`, body), { params: Promise.resolve({ anonId }) })
const inactivate = (anonId: string, id: number | string, body: unknown = { active: false }) =>
  patchAllergy(req('PATCH', `/api/patients/${anonId}/allergies/${id}`, body), { params: Promise.resolve({ anonId, id: String(id) }) })
const setStatus = (anonId: string, body: unknown) => putStatus(req('PUT', `/api/patients/${anonId}/allergy-status`, body), { params: Promise.resolve({ anonId }) })
const statusOf = async (id: string) => (await getDb().select({ s: patients.allergyStatus }).from(patients).where(eq(patients.id, id)))[0]?.s

describe.skipIf(!process.env.DATABASE_URL)('patient allergy routes (DB)', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: PATIENT, name: 'TEST_WS1T3 Allergy', dob: '1980-01-01', gender: 'male', uhid: `${PATIENT}-UH` },
      { id: OTHER, name: 'TEST_WS1T3 Other', dob: '1981-01-01', gender: 'female', uhid: `${OTHER}-UH` },
    ])
  })

  afterAll(async () => {
    const db = getDb()
    for (const id of [PATIENT, OTHER]) {
      await db.delete(allergies).where(eq(allergies.patientId, id))
      await db.delete(patients).where(eq(patients.id, id))
    }
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => { role = 'crc' })

  it('crc adds an allergy: 201, recorder stamped, patient status becomes recorded', async () => {
    expect(await statusOf(PATIENT)).toBe('unknown')
    const res = await add(PATIENT, { allergen: ' Penicillin ', reaction: 'rash', severity: 'severe' })
    expect(res.status).toBe(201)
    const { allergy } = await res.json()
    expect(allergy).toMatchObject({ allergen: 'Penicillin', reaction: 'rash', severity: 'severe', recordedByName: PROBE })
    expect(allergy.recordedAt).toBeTruthy()
    expect(await statusOf(PATIENT)).toBe('recorded')
  })

  it('refuses none_known (and unknown) while an active allergy exists: 409 has_active_allergies', async () => {
    for (const status of ['none_known', 'unknown']) {
      const res = await setStatus(PATIENT, { status })
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('has_active_allergies')
    }
    expect(await statusOf(PATIENT)).toBe('recorded')
  })

  it('inactivates an allergy: 200, the active list excludes it; a repeat or another patient\'s id is 404', async () => {
    const res = await add(PATIENT, { allergen: 'Sulfa drugs', severity: 'moderate' })
    const { allergy } = await res.json()
    const ok = await inactivate(PATIENT, allergy.id)
    expect(ok.status).toBe(200)
    const active = await listActiveAllergies(PATIENT)
    expect(active.map((a) => a.id)).not.toContain(allergy.id)
    expect(active.map((a) => a.allergen)).toContain('Penicillin')
    expect((await inactivate(PATIENT, allergy.id)).status).toBe(404)
    expect((await inactivate(OTHER, active[0].id)).status).toBe(404)
  })

  it('once no active allergy remains the status is unknown again, and none_known can then be set', async () => {
    for (const a of await listActiveAllergies(PATIENT)) expect((await inactivate(PATIENT, a.id)).status).toBe(200)
    expect(await statusOf(PATIENT)).toBe('unknown')
    const res = await setStatus(PATIENT, { status: 'none_known' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allergyStatus: 'none_known' })
    expect(await statusOf(PATIENT)).toBe('none_known')
  })

  it('pi and admin may write; frontdesk, billing and labs are 403', async () => {
    for (const r of ['pi', 'admin']) {
      role = r
      expect((await add(OTHER, { allergen: 'Aspirin', severity: 'mild' })).status).toBe(201)
    }
    for (const r of ['frontdesk', 'billing', 'labs']) {
      role = r
      expect((await add(OTHER, { allergen: 'Aspirin', severity: 'mild' })).status).toBe(403)
      expect((await setStatus(OTHER, { status: 'none_known' })).status).toBe(403)
      expect((await inactivate(OTHER, 1)).status).toBe(403)
    }
  })

  it('validates: bad bodies are 400, an unknown patient is 404', async () => {
    expect((await add(PATIENT, { allergen: 'x', severity: 'mild' })).status).toBe(400)
    expect((await add(PATIENT, { allergen: 'Latex', severity: 'fatal' })).status).toBe(400)
    expect((await add(PATIENT, { allergen: 'Latex', severity: 'mild', extra: 1 })).status).toBe(400)
    expect((await add(PATIENT, '{nope')).status).toBe(400)
    expect((await setStatus(PATIENT, { status: 'recorded' })).status).toBe(400)
    expect((await inactivate(PATIENT, 'abc')).status).toBe(400)
    expect((await inactivate(PATIENT, 1, { active: true })).status).toBe(400)
    expect((await add('RD-NOPE-ZZ', { allergen: 'Latex', severity: 'mild' })).status).toBe(404)
    expect((await setStatus('RD-NOPE-ZZ', { status: 'none_known' })).status).toBe(404)
  })

  it('audit rows carry ids and codes only, never allergen or reaction text', async () => {
    await add(PATIENT, { allergen: 'SECRETALLERGEN', reaction: 'SECRETREACTION', severity: 'mild' })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(`${r.action} ${r.details ?? ''}`).not.toMatch(/SECRET|Penicillin|Sulfa|Aspirin|rash/i)
      expect(r.details ?? '').toMatch(/^(allergy=\d+|status=(none_known|unknown))$/)
    }
  })
})
