// Encounter coding writes and status actions (SP6 Task 7) against the real local Postgres.
// Fixtures: a TEST patient (male), a TEST provider, SP3 encounters `completed` on 2099-03-01,
// TEST icd10 / icd10pcs code-system versions (never current, so the real current flags are
// never touched), and two TEST coder users. Every fixture is deleted by id, children first;
// audit rows by this run's unique probe user name.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  auditLog, codeSystems, codes, codingQueries, diagnoses, encounterCoding, encounterCodingEvents, encounterProcedures,
  encounters, patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import {
  actorFor, addEncounterDiagnosis, addEncounterProcedure, applyCodingAction, getEncounterCodingGate, loadCodingRuleInput,
  updateEncounterDiagnosis, updateEncounterProcedure, voidEncounterDiagnosis, voidEncounterProcedure,
} from '@/lib/queries/coding'

const RUN = `${Date.now()}`.slice(-8)
const PROBE_USER = `TEST-SP6-T7-${Date.now()}`
const PATIENT = `TEST-SP6-${RUN}-P7`

let providerId = 0
let coderAId = 0
let coderBId = 0
let frontdeskUserId = 0
let dxSystemId = 0
let pcsSystemId = 0
const C: Record<string, number> = {}

let PI: Session
let ADMIN: Session
let CODER: Session
let CODER_B: Session

type CodeSpec = { code: string; sexRestriction?: 'male' | 'female'; excludes?: string[] }
const DX_CODES: CodeSpec[] = [
  { code: 'U7Z.0' }, { code: 'U8Z.0', excludes: ['U8Z.1'] }, { code: 'U8Z.1' }, { code: 'U8Z.2', sexRestriction: 'female' }, { code: 'U9Z.0' },
]
const PCS_CODES: CodeSpec[] = [{ code: 'ZZ00000' }, { code: 'ZZ00001' }]

describe.skipIf(!process.env.DATABASE_URL)('encounter coding (DB)', () => {
  const encounterIds: number[] = []
  let enc: { id: number }

  async function makeEncounter(status: 'completed' | 'in_consultation' | 'cancelled' = 'completed') {
    const [e] = await getDb().insert(encounters).values({
      patientId: PATIENT, encounterType: 'opd', status, encounterDate: '2099-03-01', providerId,
      checkedInByName: PROBE_USER, completedAt: status === 'completed' ? new Date('2099-03-01T08:00:00Z') : null,
    }).returning({ id: encounters.id })
    encounterIds.push(e.id)
    return e
  }

  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP6 Coding Patient', dob: '1990-01-01', gender: 'male' })
    const [p] = await db.insert(providers).values({ name: 'TEST_SP6 Dr Coding', specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    const [a] = await db.insert(users).values({ name: 'TEST_SP6 Coder A', email: `test-sp6-${RUN}-a@example.invalid`, role: 'coder' }).returning()
    const [b] = await db.insert(users).values({ name: 'TEST_SP6 Coder B', email: `test-sp6-${RUN}-b@example.invalid`, role: 'coder' }).returning()
    const [f] = await db.insert(users).values({ name: 'TEST_SP6 Front', email: `test-sp6-${RUN}-f@example.invalid`, role: 'frontdesk' }).returning()
    coderAId = a.id
    coderBId = b.id
    frontdeskUserId = f.id
    PI = { role: 'pi', name: PROBE_USER, userId: null }
    ADMIN = { role: 'admin', name: PROBE_USER, userId: null }
    CODER = { role: 'coder', name: PROBE_USER, userId: coderAId }
    CODER_B = { role: 'coder', name: PROBE_USER, userId: coderBId }

    const system = async (kind: 'icd10' | 'icd10pcs', specs: CodeSpec[]) => {
      const [cs] = await db.insert(codeSystems).values({
        kind, version: `TEST-SP6-${RUN}-${kind}`, name: 'TEST fictional set', licenceNote: 'Test licence', sourceFileName: 'test.csv',
        sourceSha256: 'x', codeCount: specs.length, importedByName: PROBE_USER,
      }).returning()
      const rows = await db.insert(codes).values(specs.map((s) => ({
        codeSystemId: cs.id, code: s.code, display: `TEST fictional ${s.code}`, sexRestriction: s.sexRestriction ?? null, excludes: s.excludes ?? [],
      }))).returning()
      for (const r of rows) C[r.code] = r.id
      return cs.id
    }
    dxSystemId = await system('icd10', DX_CODES)
    pcsSystemId = await system('icd10pcs', PCS_CODES)
  })

  beforeEach(async () => { enc = await makeEncounter() })

  afterEach(async () => {
    const db = getDb()
    const ids = encounterIds.splice(0)
    if (ids.length) {
      await db.delete(codingQueries).where(inArray(codingQueries.encounterId, ids))
      await db.delete(encounterCodingEvents).where(inArray(encounterCodingEvents.encounterId, ids))
      await db.delete(encounterCoding).where(inArray(encounterCoding.encounterId, ids))
      await db.delete(encounterProcedures).where(inArray(encounterProcedures.encounterId, ids))
      await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
      await db.delete(encounters).where(inArray(encounters.id, ids))
    }
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(codes).where(inArray(codes.codeSystemId, [dxSystemId, pcsSystemId]))
    await db.delete(codeSystems).where(inArray(codeSystems.id, [dxSystemId, pcsSystemId]))
    await db.delete(users).where(inArray(users.id, [coderAId, coderBId, frontdeskUserId]))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(patients).where(eq(patients.id, PATIENT))
  })

  const dx = async (id: number) => (await getDb().select().from(diagnoses).where(eq(diagnoses.id, id)))[0]
  const proc = async (id: number) => (await getDb().select().from(encounterProcedures).where(eq(encounterProcedures.id, id)))[0]
  const id = (r: { ok: boolean; value?: { diagnosisId: number } } | { ok: true; value: { diagnosisId: number } }) => {
    if (!r.ok || !('value' in r) || !r.value) throw new Error('expected ok')
    return r.value.diagnosisId
  }
  const events = async (encId: number) => getDb().select().from(encounterCodingEvents).where(eq(encounterCodingEvents.encounterId, encId))
  const audits = async () => getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))

  /** Claim, add a valid primary, mark coded and finalise. */
  async function finalisedEncounter(encId: number) {
    expect((await applyCodingAction(encId, { action: 'claim' }, CODER)).ok).toBe(true)
    const d = await addEncounterDiagnosis(encId, { codeId: C['U8Z.0'], type: 'primary' }, CODER)
    expect((await applyCodingAction(encId, { action: 'mark_coded' }, CODER)).ok).toBe(true)
    expect((await applyCodingAction(encId, { action: 'finalise' }, CODER)).ok).toBe(true)
    return id(d)
  }

  it('maps roles to entry actors', () => {
    expect(actorFor('pi')).toBe('doctor')
    expect(actorFor('coder')).toBe('coder')
    expect(actorFor('admin')).toBe('coder')
  })

  it('a doctor proposes; a coder must claim before coding', async () => {
    const p = await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.0'], type: 'primary' }, PI)
    expect(p.ok && (await dx(p.value.diagnosisId)).codingStatus).toBe('proposed')
    const row = await dx(id(p))
    expect(row).toMatchObject({ encounterId: enc.id, patientId: PATIENT, code: 'U8Z.0', codeSystemKind: 'icd10', diagnosisType: 'primary', proposedByName: PROBE_USER, date: '2099-03-01', description: 'TEST fictional U8Z.0' })
    expect(await updateEncounterDiagnosis(enc.id, id(p), { codeId: C['U8Z.0'] }, CODER)).toEqual({ ok: false, error: 'not_claimed' })
    expect((await applyCodingAction(enc.id, { action: 'claim' }, CODER)).ok).toBe(true)
    expect(await updateEncounterDiagnosis(enc.id, id(p), { codeId: C['U8Z.0'] }, CODER_B)).toEqual({ ok: false, error: 'not_claimed' })
    expect((await updateEncounterDiagnosis(enc.id, id(p), { codeId: C['U8Z.0'] }, CODER)).ok).toBe(true)
    expect((await dx(id(p)))).toMatchObject({ codingStatus: 'coded', codedByName: PROBE_USER })
    const a = await audits()
    expect(a.map((x) => x.action)).toEqual(['coding: added diagnosis', 'coding: claim', 'coding: changed diagnosis'])
    expect(a[0].details).toBe(`encounter=${enc.id} diagnosis=${id(p)} status=proposed type=primary code=icd10:U8Z.0`)
    expect(a[1].details).toBe(`encounter=${enc.id} from=uncoded to=in_progress assignee=${coderAId}`)
    expect(a[2].details).toBe(`encounter=${enc.id} diagnosis=${id(p)} from=icd10:U8Z.0 to=icd10:U8Z.0 type=primary`)
    expect(a.every((x) => x.patientId === PATIENT)).toBe(true)
  })

  it('concurrent claims: exactly one succeeds', async () => {
    const rs = await Promise.all([applyCodingAction(enc.id, { action: 'claim' }, CODER), applyCodingAction(enc.id, { action: 'claim' }, CODER_B)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, error: 'already_assigned' })
    expect((await events(enc.id)).map((e) => e.action)).toEqual(['claim'])
  })

  it('claim needs a staff account; only coders can be assigned; a coder releases only their own claim', async () => {
    expect(await applyCodingAction(enc.id, { action: 'claim' }, ADMIN)).toEqual({ ok: false, error: 'no_user_account' })
    expect(await applyCodingAction(enc.id, { action: 'assign', assigneeUserId: frontdeskUserId }, ADMIN)).toEqual({ ok: false, error: 'assignee_not_coder' })
    expect(await applyCodingAction(enc.id, { action: 'assign', assigneeUserId: 2147483000 }, ADMIN)).toEqual({ ok: false, error: 'assignee_not_coder' })
    expect(await applyCodingAction(enc.id, { action: 'assign', assigneeUserId: coderBId }, ADMIN)).toEqual({ ok: true, value: { status: 'in_progress', issues: [] } })
    const [row] = await getDb().select().from(encounterCoding).where(eq(encounterCoding.encounterId, enc.id))
    expect(row).toMatchObject({ assignedToUserId: coderBId, assignedToName: 'TEST_SP6 Coder B', status: 'in_progress' })
    expect(await applyCodingAction(enc.id, { action: 'release' }, CODER)).toEqual({ ok: false, error: 'not_claimed' })
    expect((await applyCodingAction(enc.id, { action: 'release' }, CODER_B)).ok).toBe(true)
    const [after] = await getDb().select().from(encounterCoding).where(eq(encounterCoding.encounterId, enc.id))
    expect(after).toMatchObject({ assignedToUserId: null, assignedToName: null, assignedAt: null, status: 'in_progress' })
    const a = await audits()
    expect(a.find((x) => x.action === 'coding: assign')!.details).toBe(`encounter=${enc.id} from=uncoded to=in_progress assignee=${coderBId}`)
  })

  it('mark_coded blocks on errors and returns them; finalise needs a primary', async () => {
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    expect(await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER)).toEqual({ ok: false, error: 'validation_failed', issues: [expect.objectContaining({ code: 'no_diagnoses' })] })
    expect((await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.1'], type: 'secondary' }, CODER)).ok).toBe(true)
    const m = await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER)
    expect(m).toEqual({ ok: true, value: { status: 'coded', issues: [expect.objectContaining({ code: 'primary_missing', severity: 'warning' })] } })
    const f = await applyCodingAction(enc.id, { action: 'finalise' }, CODER)
    expect(f.ok).toBe(false)
    expect(!f.ok && f.error).toBe('validation_failed')
    expect(!f.ok && f.issues!.map((i) => i.code)).toContain('primary_missing')
    expect((await getEncounterCodingGate(enc.id))).toEqual({ status: 'coded', finalised: false })
    const [row] = await getDb().select().from(encounterCoding).where(eq(encounterCoding.encounterId, enc.id))
    expect(row.codedByName).toBe(PROBE_USER)
    expect(row.codedAt).not.toBeNull()
    expect(await applyCodingAction(enc.id, { action: 'finalise' }, CODER_B)).toEqual({ ok: false, error: 'not_claimed' })
  })

  it('refuses every entry write on a finalised encounter', async () => {
    const dxId = await finalisedEncounter(enc.id)
    const before = await dx(dxId)
    const results = [
      await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.1'], type: 'secondary' }, CODER),
      await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.1'], type: 'secondary' }, ADMIN),
      await addEncounterDiagnosis(enc.id, { description: 'Free text', type: 'secondary' }, PI),
      await updateEncounterDiagnosis(enc.id, dxId, { type: 'secondary' }, ADMIN),
      await updateEncounterDiagnosis(enc.id, dxId, { codeId: C['U9Z.0'] }, CODER),
      await voidEncounterDiagnosis(enc.id, dxId, PI),
      await voidEncounterDiagnosis(enc.id, dxId, CODER),
      await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: '2026-03-01' }, CODER),
      await addEncounterProcedure(enc.id, { description: 'Dressing', performedOn: '2026-03-01' }, PI),
    ]
    for (const r of results) expect(r).toEqual({ ok: false, error: 'locked' })
    expect(await dx(dxId)).toEqual(before)
    expect(await getDb().select().from(diagnoses).where(eq(diagnoses.encounterId, enc.id))).toHaveLength(1)
    expect(await getDb().select().from(encounterProcedures).where(eq(encounterProcedures.encounterId, enc.id))).toHaveLength(0)
    expect(await getEncounterCodingGate(enc.id)).toEqual({ status: 'finalised', finalised: true })
  })

  it('an edit racing finalise never leaves a finalised encounter edited', async () => {
    for (let round = 0; round < 4; round++) {
      const e = round === 0 ? enc : await makeEncounter()
      await applyCodingAction(e.id, { action: 'claim' }, CODER)
      await addEncounterDiagnosis(e.id, { codeId: C['U7Z.0'], type: 'primary' }, CODER)
      const sec = await addEncounterDiagnosis(e.id, { codeId: C['U8Z.1'], type: 'secondary' }, CODER)
      const secId = id(sec)
      expect((await applyCodingAction(e.id, { action: 'mark_coded' }, CODER)).ok).toBe(true)
      // Alternate which call is issued first, so both interleavings get exercised.
      const finalise = () => applyCodingAction(e.id, { action: 'finalise' }, CODER)
      const edit = () => updateEncounterDiagnosis(e.id, secId, { codeId: C['U9Z.0'] }, CODER)
      let fP: ReturnType<typeof finalise>
      let uP: ReturnType<typeof edit>
      if (round % 2 === 0) { fP = finalise(); uP = edit() } else { uP = edit(); fP = finalise() }
      const [f, u] = await Promise.all([fP, uP])
      const gate = await getEncounterCodingGate(e.id)
      if (gate!.finalised) {
        expect((await dx(secId)).codeId).toBe(C['U8Z.1'])
        expect(u).toEqual({ ok: false, error: 'locked' })
      } else {
        expect(f).toEqual({ ok: false, error: 'invalid_transition' })
        expect((await dx(secId)).codeId).toBe(C['U9Z.0'])
        expect(gate!.status).toBe('in_progress')
      }
      expect(u.ok || (!u.ok && u.error === 'locked')).toBe(true)
    }
  })

  it('a coder add racing finalise: either the add is refused or the finalise is', async () => {
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    await addEncounterDiagnosis(enc.id, { codeId: C['U7Z.0'], type: 'primary' }, CODER)
    await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER)
    const [f, d] = await Promise.all([
      applyCodingAction(enc.id, { action: 'finalise' }, CODER),
      addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'secondary' }, CODER),
    ])
    const rows = await getDb().select().from(diagnoses).where(eq(diagnoses.encounterId, enc.id))
    if ((await getEncounterCodingGate(enc.id))!.finalised) {
      expect(d).toEqual({ ok: false, error: 'locked' })
      expect(rows).toHaveLength(1)
    } else {
      expect(d.ok).toBe(true)
      expect(f).toEqual({ ok: false, error: 'invalid_transition' })
      expect(rows).toHaveLength(2)
    }
  })

  it('a coder edit after coded reverts to in_progress with an event', async () => {
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    const p = await addEncounterDiagnosis(enc.id, { codeId: C['U7Z.0'], type: 'primary' }, CODER)
    await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER)
    expect((await getEncounterCodingGate(enc.id))!.status).toBe('coded')
    expect((await updateEncounterDiagnosis(enc.id, id(p), { sequence: 2 }, CODER)).ok).toBe(true)
    expect((await getEncounterCodingGate(enc.id))!.status).toBe('in_progress')
    const ev = await events(enc.id)
    expect(ev.map((e) => [e.action, e.fromStatus, e.toStatus])).toEqual([
      ['claim', 'uncoded', 'in_progress'], ['mark_coded', 'in_progress', 'coded'], ['edit_after_coded', 'coded', 'in_progress'],
    ])
    expect(ev[2]).toMatchObject({ byName: PROBE_USER, byUserId: coderAId, reason: null })
  })

  it('reopen requires finalised, counts, and keeps the reason out of the audit', async () => {
    expect(await applyCodingAction(enc.id, { action: 'reopen', reason: 'payer query' }, CODER)).toEqual({ ok: false, error: 'invalid_transition' })
    await finalisedEncounter(enc.id)
    expect(await applyCodingAction(enc.id, { action: 'reopen', reason: 'payer query' }, CODER)).toEqual({ ok: true, value: { status: 'in_progress', issues: [] } })
    const [row] = await getDb().select().from(encounterCoding).where(eq(encounterCoding.encounterId, enc.id))
    expect(row).toMatchObject({ status: 'in_progress', reopenCount: 1 })
    const ev = await events(enc.id)
    expect(ev.find((e) => e.action === 'reopen')).toMatchObject({ reason: 'payer query', fromStatus: 'finalised', toStatus: 'in_progress' })
    expect(ev.filter((e) => e.action !== 'reopen').every((e) => e.reason === null)).toBe(true)
    const a = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_USER), eq(auditLog.patientId, PATIENT)))
    expect(a.find((x) => x.action === 'coding: reopen')!.details).toBe(`encounter=${enc.id} from=finalised to=in_progress`)
    for (const x of a) expect(`${x.action} ${x.details}`).not.toContain('payer query')
    // Editable again after the reopen.
    expect((await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.1'], type: 'secondary' }, CODER)).ok).toBe(true)
  })

  it('rejects a PCS code as a diagnosis and a female-only code for a male patient', async () => {
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    expect(await addEncounterDiagnosis(enc.id, { codeId: C['ZZ00000'], type: 'primary' }, CODER))
      .toEqual({ ok: false, error: 'code_invalid', issues: [expect.objectContaining({ code: 'code_system_not_allowed', severity: 'error' })] })
    expect(await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.2'], type: 'primary' }, CODER))
      .toEqual({ ok: false, error: 'code_invalid', issues: [expect.objectContaining({ code: 'sex_mismatch' })] })
    expect(await addEncounterDiagnosis(enc.id, { codeId: 2147483000, type: 'primary' }, CODER)).toEqual({ ok: false, error: 'code_not_found' })
    expect(await addEncounterDiagnosis(enc.id, { description: 'No code', type: 'primary' }, CODER)).toEqual({ ok: false, error: 'code_required' })
    expect(await addEncounterProcedure(enc.id, { codeId: C['U7Z.0'], performedOn: '2026-03-01' }, CODER))
      .toEqual({ ok: false, error: 'code_invalid', issues: [expect.objectContaining({ code: 'code_system_not_allowed' })] })
    expect(await getDb().select().from(diagnoses).where(eq(diagnoses.encounterId, enc.id))).toHaveLength(0)
  })

  it('one live primary per encounter; voiding frees the slot', async () => {
    const p = await addEncounterDiagnosis(enc.id, { codeId: C['U7Z.0'], type: 'primary' }, PI)
    expect(await addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'primary' }, PI)).toEqual({ ok: false, error: 'primary_exists' })
    const s = await addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'secondary' }, PI)
    expect(await updateEncounterDiagnosis(enc.id, id(s), { type: 'primary' }, PI)).toEqual({ ok: false, error: 'primary_exists' })
    expect((await voidEncounterDiagnosis(enc.id, id(p), PI)).ok).toBe(true)
    expect((await dx(id(p)))).toMatchObject({ voidedByName: PROBE_USER })
    expect((await updateEncounterDiagnosis(enc.id, id(s), { type: 'primary' }, PI)).ok).toBe(true)
    expect(await voidEncounterDiagnosis(enc.id, id(p), PI)).toEqual({ ok: false, error: 'entry_not_found' })
    const other = await makeEncounter()
    expect(await updateEncounterDiagnosis(other.id, id(s), { sequence: 3 }, PI)).toEqual({ ok: false, error: 'entry_not_found' })
    expect((await audits()).find((x) => x.action === 'coding: removed diagnosis')!.details).toBe(`encounter=${enc.id} diagnosis=${id(p)} code=icd10:U7Z.0`)
  })

  it('a doctor cannot edit a coded row or propose once coded', async () => {
    const p = await addEncounterDiagnosis(enc.id, { codeId: C['U7Z.0'], type: 'primary' }, PI)
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    await updateEncounterDiagnosis(enc.id, id(p), { codeId: C['U7Z.0'] }, CODER)
    expect(await updateEncounterDiagnosis(enc.id, id(p), { codeId: C['U9Z.0'] }, PI)).toEqual({ ok: false, error: 'locked' })
    expect(await voidEncounterDiagnosis(enc.id, id(p), PI)).toEqual({ ok: false, error: 'locked' })
    // A doctor may still propose while the encounter is in progress.
    expect((await addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'secondary' }, PI)).ok).toBe(true)
    await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER).then((r) => expect(r).toEqual(expect.objectContaining({ ok: false, error: 'validation_failed' })))
    await voidEncounterDiagnosis(enc.id, (await getDb().select().from(diagnoses).where(and(eq(diagnoses.encounterId, enc.id), eq(diagnoses.codingStatus, 'proposed'))))[0].id, CODER)
    expect((await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER)).ok).toBe(true)
    expect(await addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'secondary' }, PI)).toEqual({ ok: false, error: 'locked' })
  })

  it('coding requires a completed encounter', async () => {
    const open = await makeEncounter('in_consultation')
    expect(await addEncounterDiagnosis(open.id, { codeId: C['U7Z.0'], type: 'primary' }, CODER)).toEqual({ ok: false, error: 'encounter_not_completed' })
    expect(await applyCodingAction(open.id, { action: 'claim' }, CODER)).toEqual({ ok: false, error: 'encounter_not_completed' })
    const d = await addEncounterDiagnosis(open.id, { description: 'Chest pain', type: 'provisional' }, PI)
    expect(d.ok).toBe(true)
    expect(await dx(id(d))).toMatchObject({ codingStatus: 'uncoded', code: '', codeId: null, codeSystemKind: null, description: 'Chest pain', diagnosisType: 'provisional' })
    expect((await audits()).find((x) => x.action === 'coding: added diagnosis')!.details).toBe(`encounter=${open.id} diagnosis=${id(d)} status=uncoded type=provisional code=none`)
    const cancelled = await makeEncounter('cancelled')
    expect(await addEncounterDiagnosis(cancelled.id, { description: 'x', type: 'primary' }, PI)).toEqual({ ok: false, error: 'encounter_cancelled' })
    expect(await addEncounterDiagnosis(2147483000, { description: 'x', type: 'primary' }, PI)).toEqual({ ok: false, error: 'not_found' })
    // Failed writes leave no coding row behind.
    expect(await getDb().select().from(encounterCoding).where(inArray(encounterCoding.encounterId, [cancelled.id]))).toHaveLength(0)
  })

  it('refuses a future procedure date, an unknown service and an inactive doctor', async () => {
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    const tomorrow = istDateOf(new Date(Date.now() + 24 * 60 * 60 * 1000))
    expect(await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: tomorrow }, CODER)).toEqual({ ok: false, error: 'performed_in_future' })
    expect(await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: '2026-03-01', serviceId: 2147483000 }, CODER)).toEqual({ ok: false, error: 'service_not_found' })
    expect(await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: '2026-03-01', performedByProviderId: 2147483000 }, CODER)).toEqual({ ok: false, error: 'provider_not_found' })
    await getDb().update(providers).set({ isActive: false }).where(eq(providers.id, providerId))
    try {
      expect(await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: '2026-03-01', performedByProviderId: providerId }, CODER)).toEqual({ ok: false, error: 'provider_not_found' })
    } finally {
      await getDb().update(providers).set({ isActive: true }).where(eq(providers.id, providerId))
    }
  })

  it('procedures: doctor proposes, coder codes, edits and voids, all audited', async () => {
    const p = await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: '2026-03-01', performedByProviderId: providerId }, PI)
    expect(p.ok).toBe(true)
    const pid = p.ok ? p.value.procedureId : 0
    expect(await proc(pid)).toMatchObject({ codingStatus: 'proposed', code: 'ZZ00000', codeSystemKind: 'icd10pcs', patientId: PATIENT, proposedByName: PROBE_USER, createdByName: PROBE_USER, description: 'TEST fictional ZZ00000' })
    const free = await addEncounterProcedure(enc.id, { description: 'Wound dressing', performedOn: '2026-03-01' }, PI)
    expect(free.ok && (await proc(free.value.procedureId))).toMatchObject({ codingStatus: 'uncoded', code: null, codeId: null })
    await applyCodingAction(enc.id, { action: 'claim' }, CODER)
    expect((await updateEncounterProcedure(enc.id, pid, { codeId: C['ZZ00001'] }, CODER)).ok).toBe(true)
    expect(await proc(pid)).toMatchObject({ codingStatus: 'coded', code: 'ZZ00001', codedByName: PROBE_USER })
    expect(await updateEncounterProcedure(enc.id, pid, { performedOn: '2026-03-02' }, PI)).toEqual({ ok: false, error: 'locked' })
    expect((await voidEncounterProcedure(enc.id, pid, CODER)).ok).toBe(true)
    expect(await updateEncounterProcedure(enc.id, pid, { sequence: 1 }, CODER)).toEqual({ ok: false, error: 'entry_not_found' })
    const a = (await audits()).filter((x) => x.action.includes('procedure'))
    expect(a.map((x) => x.action)).toEqual(['coding: added procedure', 'coding: added procedure', 'coding: changed procedure', 'coding: removed procedure'])
    expect(a[0].details).toBe(`encounter=${enc.id} procedure=${pid} status=proposed code=icd10pcs:ZZ00000`)
    expect(a[2].details).toBe(`encounter=${enc.id} procedure=${pid} from=icd10pcs:ZZ00000 to=icd10pcs:ZZ00001`)
  })

  it('rule input holds live rows only; the gate reads uncoded without a row and null for no encounter', async () => {
    expect(await getEncounterCodingGate(enc.id)).toEqual({ status: 'uncoded', finalised: false })
    expect(await getEncounterCodingGate(2147483000)).toBeNull()
    const a = await addEncounterDiagnosis(enc.id, { codeId: C['U7Z.0'], type: 'primary' }, PI)
    const b = await addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'secondary' }, PI)
    await voidEncounterDiagnosis(enc.id, id(b), PI)
    const input = await loadCodingRuleInput(getDb(), enc.id)
    expect(input).toMatchObject({ encounterDate: '2099-03-01', encounterEndDate: '2099-03-01', patient: { gender: 'male', dob: '1990-01-01' } })
    expect(input!.diagnoses.map((d) => d.id)).toEqual([id(a)])
    expect(input!.diagnoses[0].code).toMatchObject({ id: C['U7Z.0'], kind: 'icd10', code: 'U7Z.0' })
    expect(await loadCodingRuleInput(getDb(), 2147483000)).toBeNull()
  })
})
