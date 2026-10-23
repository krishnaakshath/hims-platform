// WS1 T4: POST /api/encounters/[id]/diagnoses and PATCH/DELETE .../diagnoses/[diagnosisId] against
// the worktree test DB. Session and the doctor's provider resolver are mocked; everything else is
// real. The real current icd10 version is saved and restored around the file.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, codeSystems, codes, diagnoses, encounterCoding, encounters, patients, providers } from '@/db/schema'

let role = 'admin'
let actingProvider: { id: number; name: string } | null = null
const PROBE = `TEST_WS1T4D-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postDiagnosis } from '@/app/api/encounters/[id]/diagnoses/route'
import { PATCH as patchDiagnosis, DELETE as deleteDiagnosis } from '@/app/api/encounters/[id]/diagnoses/[diagnosisId]/route'
import { listEncounterDiagnoses, listProblemList } from '@/lib/queries/encounter-diagnoses'

const RUN = `${Date.now()}`.slice(-7)
const PATIENT = `TWS1T4D-${RUN}`
const SECRET_TEXT = 'SECRET-DIAGNOSIS-TEXT'

const post = (id: number, body: unknown) =>
  postDiagnosis(new NextRequest(`http://localhost/api/encounters/${id}/diagnoses`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })
const patch = (id: number, dx: number, body: unknown) =>
  patchDiagnosis(new NextRequest(`http://localhost/api/encounters/${id}/diagnoses/${dx}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id), diagnosisId: String(dx) }) })
const del = (id: number, dx: number) =>
  deleteDiagnosis(new NextRequest(`http://localhost/api/encounters/${id}/diagnoses/${dx}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(id), diagnosisId: String(dx) }) })

describe.skipIf(!process.env.DATABASE_URL)('encounter diagnoses routes (DB)', () => {
  let providerA = 0
  let providerB = 0
  let openA = 0
  let openA2 = 0
  let openB = 0
  let codedA = 0
  let currentCodeId = 0 // R50.9 in the TEST current licensed version
  let secondCodeId = 0 // J06.9 in the same version
  let sampleCodeId = 0 // R50.9 in a SAMPLE version
  let oldCodeId = 0 // R50.9 in an older, non-current licensed version
  let maleOnlyCodeId = 0 // N40 (male only) in the current version; the patient is female
  let infantCodeId = 0 // P07.3 (age 0..1) in the current version; the patient was born 1980
  let savedCurrent: number[] = []
  const encounterIds: number[] = []
  const systemIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const cur = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.isCurrent, true)))
    savedCurrent = cur.map((c) => c.id)
    if (savedCurrent.length) await db.update(codeSystems).set({ isCurrent: false }).where(inArray(codeSystems.id, savedCurrent))
    const load = async (version: string, isSample: boolean, isCurrent: boolean, rows: { code: string; display: string; sexRestriction?: 'male' | 'female'; ageMinYears?: number; ageMaxYears?: number }[]) => {
      const [cs] = await db.insert(codeSystems).values({
        kind: 'icd10', version, name: 'T', isSample, isCurrent, licenceNote: isSample ? null : 'test',
        sourceFileName: 't.csv', sourceSha256: 'x', codeCount: rows.length, importedByName: 'test',
      }).returning({ id: codeSystems.id })
      systemIds.push(cs.id)
      const ins = await db.insert(codes).values(rows.map((r) => ({ selectable: true, active: true, excludes: [], ...r, codeSystemId: cs.id }))).returning({ id: codes.id })
      return ins.map((r) => r.id)
    }
    ;[currentCodeId, secondCodeId, maleOnlyCodeId, infantCodeId] = await load(`TEST-WS1T4-${RUN}`, false, true, [
      { code: 'R50.9', display: 'Fever, unspecified' }, { code: 'J06.9', display: 'Acute upper respiratory infection, unspecified' },
      { code: 'N40', display: 'Hyperplasia of prostate', sexRestriction: 'male' }, { code: 'P07.3', display: 'Other preterm infants', ageMinYears: 0, ageMaxYears: 1 },
    ])
    ;[sampleCodeId] = await load(`SAMPLE-TEST-WS1T4-${RUN}`, true, false, [{ code: 'R50.9', display: 'SAMPLE fever' }])
    ;[oldCodeId] = await load(`TEST-WS1T4-OLD-${RUN}`, false, false, [{ code: 'R50.9', display: 'Old fever' }])

    const [a] = await db.insert(providers).values({ name: `${PROBE} Dr A`, specialty: 'Test', colorTag: '#000000' }).returning()
    const [b] = await db.insert(providers).values({ name: `${PROBE} Dr B`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerA = a.id
    providerB = b.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS1T4 Patient', dob: '1980-01-01', gender: 'female', uhid: `${PATIENT}-UH` })
    const mk = async (providerId: number, status: 'in_consultation' | 'completed') => {
      const [e] = await db.insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status, checkedInByName: PROBE }).returning()
      encounterIds.push(e.id)
      return e.id
    }
    openA = await mk(providerA, 'in_consultation')
    openA2 = await mk(providerA, 'in_consultation')
    openB = await mk(providerB, 'in_consultation')
    codedA = await mk(providerA, 'completed')
    await db.insert(encounterCoding).values({ encounterId: codedA, patientId: PATIENT, status: 'coded' })
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    await db.delete(encounterCoding).where(inArray(encounterCoding.encounterId, encounterIds))
    await db.delete(encounters).where(inArray(encounters.id, encounterIds))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerA, providerB]))
    await db.delete(codes).where(inArray(codes.codeSystemId, systemIds))
    await db.delete(codeSystems).where(inArray(codeSystems.id, systemIds))
    if (savedCurrent.length) await db.update(codeSystems).set({ isCurrent: true }).where(inArray(codeSystems.id, savedCurrent))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => {
    role = 'admin'
    actingProvider = null
  })

  it('a coded pick from the current WHO ICD-10 version is proposed, with the code value', async () => {
    const res = await post(openA, { codeId: currentCodeId, diagnosisType: 'secondary' })
    expect(res.status).toBe(201)
    const { diagnosis } = await res.json()
    const [row] = await getDb().select().from(diagnoses).where(eq(diagnoses.id, diagnosis.id))
    expect(row).toMatchObject({
      encounterId: openA, patientId: PATIENT, codeId: currentCodeId, codeSystemKind: 'icd10', code: 'R50.9',
      codeDisplay: 'Fever, unspecified', description: 'Fever, unspecified', diagnosisType: 'secondary',
      codingStatus: 'proposed', proposedByName: PROBE, createdByName: PROBE, date: '2026-10-01', onProblemList: false,
    })
    expect(row.proposedAt).not.toBeNull()
  })

  it('a sample-version or non-current code is 422 code_not_current', async () => {
    for (const codeId of [sampleCodeId, oldCodeId, 2147483000]) {
      const res = await post(openA, { codeId, diagnosisType: 'secondary' })
      expect(res.status).toBe(422)
      expect((await res.json()).code).toBe('code_not_current')
    }
  })

  it('SP6 code checks apply: a code that does not fit the patient\'s sex or age is 422 code_not_valid_for_patient', async () => {
    for (const [codeId, issue] of [[maleOnlyCodeId, 'sex_mismatch'], [infantCodeId, 'age_out_of_range']] as const) {
      const res = await post(openA, { codeId, diagnosisType: 'secondary' })
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.code).toBe('code_not_valid_for_patient')
      expect(body.issues.map((i: { code: string }) => i.code)).toContain(issue)
    }
    const rows = await getDb().select({ id: diagnoses.id }).from(diagnoses).where(inArray(diagnoses.codeId, [maleOnlyCodeId, infantCodeId]))
    expect(rows).toEqual([])
  })

  it('free text is uncoded with an empty code', async () => {
    const res = await post(openA, { text: `  ${SECRET_TEXT}  `, diagnosisType: 'provisional' })
    expect(res.status).toBe(201)
    const { diagnosis } = await res.json()
    const [row] = await getDb().select().from(diagnoses).where(eq(diagnoses.id, diagnosis.id))
    expect(row).toMatchObject({ code: '', codeId: null, codeSystemKind: null, codingStatus: 'uncoded', description: SECRET_TEXT, diagnosisType: 'provisional' })
  })

  it('rejects a body with neither code nor text, or extra keys', async () => {
    expect((await post(openA, { diagnosisType: 'primary' })).status).toBe(400)
    expect((await post(openA, { text: 'Fever', diagnosisType: 'primary', code: 'X' })).status).toBe(400)
  })

  it('a second primary is 409 primary_exists; voiding the first frees the slot (soft void)', async () => {
    const first = await post(openA2, { codeId: currentCodeId, diagnosisType: 'primary' })
    expect(first.status).toBe(201)
    const firstId = (await first.json()).diagnosis.id
    const second = await post(openA2, { codeId: secondCodeId, diagnosisType: 'primary' })
    expect(second.status).toBe(409)
    expect((await second.json()).code).toBe('primary_exists')

    const removed = await del(openA2, firstId)
    expect(removed.status).toBe(200)
    const [row] = await getDb().select().from(diagnoses).where(eq(diagnoses.id, firstId))
    expect(row.voidedAt).not.toBeNull()
    expect(row.voidedByName).toBe(PROBE)
    expect((await listEncounterDiagnoses(openA2)).map((d) => d.id)).not.toContain(firstId)
    expect((await post(openA2, { codeId: secondCodeId, diagnosisType: 'primary' })).status).toBe(201)
    // A voided diagnosis is gone: a second delete is 404.
    expect((await del(openA2, firstId)).status).toBe(404)
  })

  it('once the encounter is coded, doctor edits are 409 coding_locked', async () => {
    const res = await post(codedA, { text: 'Fever', diagnosisType: 'secondary' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('coding_locked')
  })

  it('PATCH onProblemList puts the diagnosis on the problem list; type changes respect the primary rule', async () => {
    const res = await post(openA, { codeId: secondCodeId, diagnosisType: 'secondary' })
    const id = (await res.json()).diagnosis.id
    expect((await listProblemList(PATIENT)).map((p) => p.id)).not.toContain(id)
    expect((await patch(openA, id, { onProblemList: true })).status).toBe(200)
    const list = await listProblemList(PATIENT)
    expect(list.find((p) => p.id === id)).toEqual({ id, label: 'Acute upper respiratory infection, unspecified', code: 'J06.9', since: '2026-10-01' })
    expect((await patch(openA, id, {})).status).toBe(400)
    expect((await patch(openA, 2147483000, { onProblemList: true })).status).toBe(404)
    expect((await patch(openB, id, { onProblemList: false })).status).toBe(404) // not this encounter's diagnosis
  })

  it('pi writes only on their own visit; frontdesk and crc are 403', async () => {
    role = 'pi'
    actingProvider = { id: providerA, name: 'Dr A' }
    expect((await post(openA, { text: 'Fever', diagnosisType: 'secondary' })).status).toBe(201)
    const other = await post(openB, { text: 'Fever', diagnosisType: 'secondary' })
    expect(other.status).toBe(403)
    expect(await other.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
    for (const r of ['frontdesk', 'crc']) {
      role = r
      expect((await post(openA, { text: 'Fever', diagnosisType: 'secondary' })).status).toBe(403)
    }
  })

  it('audit rows carry ids only, never the diagnosis text', async () => {
    const rows = (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))).filter((r) => /diagnosis/.test(r.action))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.details ?? '').not.toContain(SECRET_TEXT)
      expect(r.details ?? '').not.toContain('Fever')
      expect(r.details ?? '').toMatch(/^encounter=\d+ diagnosis=\d+/)
    }
  })
})
