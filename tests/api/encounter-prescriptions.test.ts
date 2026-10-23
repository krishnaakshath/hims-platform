// WS1 T6: POST /api/encounters/[id]/prescriptions (multi-drug, dose pattern, mandatory dose,
// allergy check) and GET /api/medications/search, against the worktree's isolated test DB.
// The session and the doctor's provider resolver are mocked; every row is a TEST fixture.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  allergies, auditLog, encounters, medicationEpisodes, medicationInventory, medications, patients, prescriptions, providers,
} from '@/db/schema'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'pi'
let actingProvider: { id: number; name: string } | null = null

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'TEST_WS6 Doctor', userId: null })) }
})
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postPrescriptions } from '@/app/api/encounters/[id]/prescriptions/route'
import { GET as searchMedications } from '@/app/api/medications/search/route'

const TAG = `TWS6-${Date.now()}`
const PATIENT = `${TAG}-P`
let ownerProvider: { id: number; name: string }
let otherProvider: { id: number; name: string }
let encounterId: number
let closedEncounterId: number
const med: Record<'amox' | 'para' | 'syrup' | 'ceti', number> = { amox: 0, para: 0, syrup: 0, ceti: 0 }

beforeAll(async () => {
  const db = getDb()
  const provs = await db.select({ id: providers.id, name: providers.name }).from(providers).where(eq(providers.isActive, true)).limit(2)
  if (provs.length < 2) throw new Error('Need two active providers')
  ;[ownerProvider, otherProvider] = provs
  await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS6 Patient', dob: '1990-01-01' })
  const [e] = await db.insert(encounters).values({
    patientId: PATIENT, encounterType: 'opd', status: 'in_consultation', encounterDate: '2026-10-20',
    providerId: ownerProvider.id, checkedInByName: 'TEST_WS6',
  }).returning()
  encounterId = e.id
  const [c] = await db.insert(encounters).values({
    patientId: PATIENT, encounterType: 'opd', status: 'completed', encounterDate: '2026-10-19',
    providerId: ownerProvider.id, checkedInByName: 'TEST_WS6',
  }).returning()
  closedEncounterId = c.id
  const rows = await db.insert(medications).values([
    { name: `${TAG} Mox 500`, genericName: 'Amoxicillin', medicationClass: 'Antibiotic', commonDose: '500 mg', form: 'capsule' },
    { name: `${TAG} Dolo 650`, genericName: 'Paracetamol', medicationClass: 'Analgesic', commonDose: '650 mg', form: 'tablet' },
    { name: `${TAG} Cough syrup`, genericName: 'Dextromethorphan', medicationClass: 'Antitussive', commonDose: '10 ml', form: 'liquid' },
    { name: `${TAG} Cetzine`, genericName: 'Cetirizine', medicationClass: 'Antihistamine', commonDose: '10 mg', form: 'tablet' },
  ]).returning()
  ;[med.amox, med.para, med.syrup, med.ceti] = rows.map((r) => r.id)
  await db.insert(medicationInventory).values({ medicationId: med.para, quantityOnHand: 40 })
  await db.insert(medicationInventory).values({ medicationId: med.ceti, quantityOnHand: 0 })
})

afterEach(async () => {
  sessionRole = 'pi'
  actingProvider = ownerProvider
  const db = getDb()
  await db.delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, PATIENT))
  await db.delete(prescriptions).where(eq(prescriptions.patientId, PATIENT))
  await db.delete(allergies).where(eq(allergies.patientId, PATIENT))
})

afterAll(async () => {
  const db = getDb()
  await db.delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, PATIENT))
  await db.delete(prescriptions).where(eq(prescriptions.patientId, PATIENT))
  await db.delete(allergies).where(eq(allergies.patientId, PATIENT))
  await db.delete(encounters).where(eq(encounters.patientId, PATIENT))
  const ids = Object.values(med)
  await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, ids))
  await db.delete(medications).where(inArray(medications.id, ids))
  await db.delete(patients).where(eq(patients.id, PATIENT))
})

const post = (id: number | string, body: unknown) =>
  postPrescriptions(
    new NextRequest(`http://localhost/api/encounters/${id}/prescriptions`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(id) }) },
  )

const item = (over: Record<string, unknown> = {}) => ({
  medicationId: med.para, name: `${TAG} Dolo 650`, medicationClass: 'Analgesic', dose: '650 mg',
  dosePattern: '1-0-1', durationDays: 5, route: 'oral', foodTiming: 'after_food', ...over,
})

async function rowsFor() {
  const db = getDb()
  const headers = await db.select().from(prescriptions).where(eq(prescriptions.patientId, PATIENT))
  const episodes = await db.select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, PATIENT)).orderBy(medicationEpisodes.id)
  return { headers, episodes }
}

describe('POST /api/encounters/[id]/prescriptions', () => {
  beforeAll(() => { actingProvider = ownerProvider })

  it('writes 3 drugs under one prescription header with derived frequency and quantity', async () => {
    const res = await post(encounterId, {
      advice: 'Plenty of fluids',
      items: [
        item(),
        item({ medicationId: med.amox, name: `${TAG} Mox 500`, medicationClass: 'Antibiotic', dose: '500 mg', dosePattern: '1-1-1', durationDays: 7, foodTiming: undefined }),
        item({ medicationId: null, name: 'TEST_WS6 Free-text drug', medicationClass: 'Other', dose: '1 tab', dosePattern: undefined, isSos: true, durationDays: 3, instructions: 'If fever' }),
      ],
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.episodeIds).toHaveLength(3)
    const { headers, episodes } = await rowsFor()
    expect(headers).toHaveLength(1)
    expect(body.prescriptionId).toBe(headers[0].id)
    expect(headers[0]).toMatchObject({ encounterId, prescribedByProviderId: ownerProvider.id, advice: 'Plenty of fluids', enteredByName: 'TEST_WS6 Doctor' })
    expect(episodes.map((e) => e.prescriptionId)).toEqual([headers[0].id, headers[0].id, headers[0].id])
    expect(episodes.map((e) => e.frequencyPerDay)).toEqual([2, 3, null])
    expect(episodes.map((e) => e.quantityPrescribed)).toEqual([10, 21, null])
    expect(episodes.map((e) => e.dosePattern)).toEqual(['1-0-1', '1-1-1', null])
    expect(episodes.map((e) => e.isSos)).toEqual([false, false, true])
    expect(episodes.map((e) => e.route)).toEqual(['oral', 'oral', 'oral'])
    expect(episodes.map((e) => e.foodTiming)).toEqual(['after_food', null, 'after_food'])
    for (const e of episodes) {
      expect(e).toMatchObject({ status: 'active', startDate: '2026-10-20', prescribedByProviderId: ownerProvider.id, enteredByName: 'TEST_WS6 Doctor', allergyOverrideReason: null })
      expect(e.prescribedAt).toBeInstanceOf(Date)
    }
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, PATIENT), eq(auditLog.action, 'wrote prescription'))).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`prescription=${headers[0].id} items=3 overrides=0`)
  })

  it('a missing dose is 400 and writes nothing', async () => {
    const { dose: _dose, ...noDose } = item()
    void _dose
    expect((await post(encounterId, { items: [noDose] })).status).toBe(400)
    expect((await post(encounterId, { items: [item({ dose: '   ' })] })).status).toBe(400)
    const { headers, episodes } = await rowsFor()
    expect(headers).toHaveLength(0)
    expect(episodes).toHaveLength(0)
  })

  it('an invalid pattern, or no pattern/frequency/SOS at all, is 400', async () => {
    expect((await post(encounterId, { items: [item({ dosePattern: '3-0-1' })] })).status).toBe(400)
    expect((await post(encounterId, { items: [item({ dosePattern: undefined })] })).status).toBe(400)
    expect((await post(encounterId, { items: [item({ route: 'by mouth' })] })).status).toBe(400)
    expect((await post(encounterId, { items: [] })).status).toBe(400)
    expect((await post(encounterId, { items: [item({ extra: 1 })] })).status).toBe(400)
  })

  it('frequencyPerDay alone is accepted when no pattern is given', async () => {
    const res = await post(encounterId, { items: [item({ dosePattern: undefined, frequencyPerDay: 3, durationDays: 2 })] })
    expect(res.status).toBe(201)
    const { episodes } = await rowsFor()
    expect(episodes[0]).toMatchObject({ frequencyPerDay: 3, quantityPrescribed: 6, dosePattern: null })
  })

  it('a liquid has no prescribed quantity', async () => {
    const res = await post(encounterId, { items: [item({ medicationId: med.syrup, name: `${TAG} Cough syrup`, medicationClass: 'Antitussive', dose: '10 ml' })] })
    expect(res.status).toBe(201)
    expect((await rowsFor()).episodes[0].quantityPrescribed).toBeNull()
  })

  it('an allergy conflict without an override reason is 422 listing the item index; nothing is written', async () => {
    await getDb().insert(allergies).values({ patientId: PATIENT, allergen: 'Penicillin', severity: 'severe' })
    const res = await post(encounterId, {
      items: [item(), item({ medicationId: med.amox, name: `${TAG} Mox 500`, medicationClass: 'Antibiotic', dose: '500 mg' })],
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('allergy_conflict')
    expect(body.conflicts).toEqual([{ index: 1, conflicts: [{ allergen: 'Penicillin', severity: 'severe', matchedOn: 'cross_reactivity' }] }])
    const { headers, episodes } = await rowsFor()
    expect(headers).toHaveLength(0)
    expect(episodes).toHaveLength(0)
  })

  it('an inactivated allergy is not a conflict', async () => {
    await getDb().insert(allergies).values({ patientId: PATIENT, allergen: 'Penicillin', severity: 'severe', inactivatedAt: new Date() })
    const res = await post(encounterId, { items: [item({ medicationId: med.amox, name: `${TAG} Mox 500`, medicationClass: 'Antibiotic', dose: '500 mg' })] })
    expect(res.status).toBe(201)
  })

  it('uses the catalogue generic name even when the client omits it', async () => {
    await getDb().insert(allergies).values({ patientId: PATIENT, allergen: 'Amoxicillin', severity: 'mild' })
    const res = await post(encounterId, { items: [item({ medicationId: med.amox, name: 'Mox', medicationClass: 'Antibiotic', dose: '500 mg' })] })
    expect(res.status).toBe(422)
  })

  it('always checks the catalogue identity: a client-sent class cannot dodge a class match (fix round 1)', async () => {
    await getDb().insert(allergies).values({ patientId: PATIENT, allergen: 'Antibiotic', severity: 'moderate' })
    const res = await post(encounterId, { items: [item({ medicationId: med.amox, name: `${TAG} Mox 500`, medicationClass: 'Other', dose: '500 mg' })] })
    expect(res.status).toBe(422)
    expect((await res.json()).conflicts).toEqual([{ index: 0, conflicts: [{ allergen: 'Antibiotic', severity: 'moderate', matchedOn: 'class' }] }])
  })

  it('with an override reason the conflict is written (201) and the reason stored', async () => {
    await getDb().insert(allergies).values({ patientId: PATIENT, allergen: 'Penicillin', severity: 'mild' })
    const res = await post(encounterId, {
      items: [item({ medicationId: med.amox, name: `${TAG} Mox 500`, medicationClass: 'Antibiotic', dose: '500 mg', allergyOverrideReason: 'Tolerated amoxicillin in 2024' })],
    })
    expect(res.status).toBe(201)
    const { headers, episodes } = await rowsFor()
    expect(episodes[0].allergyOverrideReason).toBe('Tolerated amoxicillin in 2024')
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, PATIENT), eq(auditLog.action, 'wrote prescription'))).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`prescription=${headers[0].id} items=1 overrides=1`)
  })

  it('an unknown medicationId is 422 medication_not_found with the index', async () => {
    const res = await post(encounterId, { items: [item(), item({ medicationId: 2147483000 })] })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'medication_not_found', index: 1 })
    expect((await rowsFor()).headers).toHaveLength(0)
  })

  it("another doctor's encounter is 403 not_owner", async () => {
    actingProvider = otherProvider
    const res = await post(encounterId, { items: [item()] })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
    expect((await rowsFor()).headers).toHaveLength(0)
  })

  it('admin writes on any encounter, attributed to the encounter doctor', async () => {
    sessionRole = 'admin'
    actingProvider = null
    const res = await post(encounterId, { items: [item()] })
    expect(res.status).toBe(201)
    expect((await rowsFor()).headers[0].prescribedByProviderId).toBe(ownerProvider.id)
  })

  it('a closed visit is 409 visit_closed', async () => {
    const res = await post(closedEncounterId, { items: [item()] })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Visit is closed', code: 'visit_closed' })
  })

  it('an unknown encounter is 404 and a malformed id is 404', async () => {
    expect((await post(2147483000, { items: [item()] })).status).toBe(404)
    expect((await post('abc', { items: [item()] })).status).toBe(404)
  })

  it.each(['crc', 'frontdesk', 'pharmacy', 'billing'] as const)('%s is 403 before parsing', async (role) => {
    sessionRole = role
    const res = await post(encounterId, '{not json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })
})

describe('GET /api/medications/search', () => {
  const search = (q: string | null) => searchMedications(new NextRequest(`http://localhost/api/medications/search${q === null ? '' : `?q=${encodeURIComponent(q)}`}`))

  it('finds by name or generic name, with stock', async () => {
    sessionRole = 'pharmacy'
    const res = await search(TAG)
    expect(res.status).toBe(200)
    const { items } = await res.json()
    expect(items.map((i: { id: number }) => i.id).sort()).toEqual(Object.values(med).sort())
    expect(items.find((i: { id: number }) => i.id === med.para)).toEqual({
      id: med.para, name: `${TAG} Dolo 650`, genericName: 'Paracetamol', medicationClass: 'Analgesic', form: 'tablet', commonDose: '650 mg', inStock: true,
    })
    expect(items.find((i: { id: number }) => i.id === med.ceti).inStock).toBe(false)
    expect(items.find((i: { id: number }) => i.id === med.amox).inStock).toBe(false)
    const byGeneric = await (await search('dextromethorphan')).json()
    expect(byGeneric.items.map((i: { id: number }) => i.id)).toContain(med.syrup)
  })

  it('treats % and _ literally and caps at 20 rows', async () => {
    sessionRole = 'pi'
    expect((await (await search('%%')).json()).items).toEqual([])
    const res = await (await search('in')).json()
    expect(res.items.length).toBeLessThanOrEqual(20)
  })

  it.each([null, 'a', ' a ', 'x'.repeat(61)])('q=%j is 400', async (q) => {
    sessionRole = 'admin'
    expect((await search(q)).status).toBe(400)
  })

  it.each(['crc', 'frontdesk', 'billing'] as const)('%s is 403', async (role) => {
    sessionRole = role
    expect((await search(TAG)).status).toBe(403)
  })
})
