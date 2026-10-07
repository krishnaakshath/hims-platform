// Coding queries to doctors with a response log (SP6 Task 8) against the real local Postgres.
// Fixtures: a TEST patient, two TEST providers, a TEST coder user and SP3 encounters
// `completed` on 2099-03-01, all deleted by id children first; audit rows by this run's
// unique probe user name.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  auditLog, codeSystems, codes, codingQueries, codingQueryResponses, diagnoses, encounterCoding, encounterCodingEvents, encounters,
  patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { addEncounterDiagnosis, applyCodingAction, getEncounterCodingGate } from '@/lib/queries/coding'
import {
  closeCodingQuery, listOpenCodingQueriesForProvider, raiseCodingQuery, respondToCodingQuery,
} from '@/lib/queries/coding-queries'

const RUN = `${Date.now()}`.slice(-8)
const PROBE_USER = `TEST-SP6-T8Q-${Date.now()}`
const PATIENT = `TEST-SP6-${RUN}-PQ`

let docId = 0
let otherDocId = 0
let coderId = 0
let otherCoderId = 0
let systemId = 0
let codeId = 0
let PI: Session
let ADMIN: Session
let CODER: Session
let CODER_B: Session

describe.skipIf(!process.env.DATABASE_URL)('coding queries (DB)', () => {
  const encounterIds: number[] = []
  let enc: { id: number }

  async function makeEncounter(status: 'completed' | 'in_consultation' = 'completed') {
    const [e] = await getDb().insert(encounters).values({
      patientId: PATIENT, encounterType: 'opd', status, encounterDate: '2099-03-01', providerId: docId,
      checkedInByName: PROBE_USER, completedAt: status === 'completed' ? new Date('2099-03-01T08:00:00Z') : null,
    }).returning({ id: encounters.id })
    encounterIds.push(e.id)
    return e
  }

  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP6 Query Patient', dob: '1975-04-04', gender: 'female', uhid: `TSP6Q${RUN}` })
    const [d1] = await db.insert(providers).values({ name: 'TEST_SP6 Dr Query', specialty: 'Test', colorTag: '#000000' }).returning()
    const [d2] = await db.insert(providers).values({ name: 'TEST_SP6 Dr Other', specialty: 'Test', colorTag: '#000000' }).returning()
    docId = d1.id
    otherDocId = d2.id
    const [c] = await db.insert(users).values({ name: 'TEST_SP6 Query Coder', email: `test-sp6-${RUN}-qc@example.invalid`, role: 'coder' }).returning()
    const [c2] = await db.insert(users).values({ name: 'TEST_SP6 Query Coder B', email: `test-sp6-${RUN}-qc2@example.invalid`, role: 'coder' }).returning()
    coderId = c.id
    otherCoderId = c2.id
    const [cs] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `TEST-SP6-${RUN}-q`, name: 'TEST fictional set', licenceNote: 'Test licence', sourceFileName: 'test.csv',
      sourceSha256: 'x', codeCount: 1, importedByName: PROBE_USER,
    }).returning()
    systemId = cs.id
    const [code] = await db.insert(codes).values({ codeSystemId: cs.id, code: 'U7Z.0', display: 'TEST fictional U7Z.0' }).returning()
    codeId = code.id
    PI = { role: 'pi', name: PROBE_USER, userId: null }
    ADMIN = { role: 'admin', name: PROBE_USER, userId: null }
    CODER = { role: 'coder', name: PROBE_USER, userId: coderId }
    CODER_B = { role: 'coder', name: PROBE_USER, userId: otherCoderId }
  })

  beforeEach(async () => {
    enc = await makeEncounter()
    expect((await applyCodingAction(enc.id, { action: 'claim' }, CODER)).ok).toBe(true)
  })

  afterEach(async () => {
    const db = getDb()
    const ids = encounterIds.splice(0)
    if (ids.length) {
      const qs = await db.select({ id: codingQueries.id }).from(codingQueries).where(inArray(codingQueries.encounterId, ids))
      if (qs.length) await db.delete(codingQueryResponses).where(inArray(codingQueryResponses.queryId, qs.map((q) => q.id)))
      await db.delete(codingQueries).where(inArray(codingQueries.encounterId, ids))
      await db.delete(encounterCodingEvents).where(inArray(encounterCodingEvents.encounterId, ids))
      await db.delete(encounterCoding).where(inArray(encounterCoding.encounterId, ids))
      await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
      await db.delete(encounters).where(inArray(encounters.id, ids))
    }
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(codes).where(eq(codes.codeSystemId, systemId))
    await db.delete(codeSystems).where(eq(codeSystems.id, systemId))
    await db.delete(users).where(inArray(users.id, [coderId, otherCoderId]))
    await db.delete(providers).where(inArray(providers.id, [docId, otherDocId]))
    await db.delete(patients).where(eq(patients.id, PATIENT))
  })

  const qid = (r: Awaited<ReturnType<typeof raiseCodingQuery>>) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
    return r.value.queryId
  }
  const query = async (id: number) => (await getDb().select().from(codingQueries).where(eq(codingQueries.id, id)))[0]

  it('raising a query moves the encounter to queried; resume waits for open queries', async () => {
    const q = await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Laterality?' }, CODER)
    expect(await query(qid(q))).toMatchObject({ status: 'open', encounterId: enc.id, patientId: PATIENT, raisedByName: PROBE_USER, raisedByUserId: coderId, question: 'Laterality?' })
    expect((await getEncounterCodingGate(enc.id))!.status).toBe('queried')
    expect(await applyCodingAction(enc.id, { action: 'resume' }, CODER)).toEqual({ ok: false, error: 'open_queries' })
    const r = await respondToCodingQuery(qid(q), 'Left', PI)
    expect(r.ok).toBe(true)
    expect((await query(qid(q))).status).toBe('answered')
    expect((await query(qid(q))).answeredAt).not.toBeNull()
    const [resp] = await getDb().select().from(codingQueryResponses).where(eq(codingQueryResponses.queryId, qid(q)))
    expect(resp).toMatchObject({ authorName: PROBE_USER, authorRole: 'pi', body: 'Left' })
    expect((await applyCodingAction(enc.id, { action: 'resume' }, CODER)).ok).toBe(true)
    expect((await getEncounterCodingGate(enc.id))!.status).toBe('in_progress')
    const ev = await getDb().select().from(encounterCodingEvents).where(eq(encounterCodingEvents.encounterId, enc.id))
    expect(ev.map((e) => [e.action, e.fromStatus, e.toStatus])).toEqual([['claim', 'uncoded', 'in_progress'], ['raise_query', 'in_progress', 'queried'], ['resume', 'queried', 'in_progress']])
    const a = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(a.find((x) => x.action === 'coding: raised query')!.details).toBe(`encounter=${enc.id} query=${qid(q)} to=provider:${docId}`)
    expect(a.find((x) => x.action === 'coding: responded to query')!.details).toBe(`query=${qid(q)} encounter=${enc.id}`)
  })

  it('a coder reply keeps the query open; an admin reply answers it', async () => {
    const q = qid(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Which side?' }, CODER))
    expect((await respondToCodingQuery(q, 'Adding context', CODER)).ok).toBe(true)
    expect((await query(q)).status).toBe('open')
    expect((await respondToCodingQuery(q, 'Right side', ADMIN)).ok).toBe(true)
    expect((await query(q)).status).toBe('answered')
    const rs = await getDb().select().from(codingQueryResponses).where(eq(codingQueryResponses.queryId, q))
    expect(rs.map((r) => r.authorRole).sort()).toEqual(['admin', 'coder'])
  })

  it('a closed query refuses replies; audit details never carry question or reply text', async () => {
    const q = qid(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Laterality?' }, CODER))
    expect((await respondToCodingQuery(q, 'Left', PI)).ok).toBe(true)
    expect(await closeCodingQuery(q, 'close', CODER)).toEqual({ ok: true, value: { status: 'closed' } })
    expect(await query(q)).toMatchObject({ status: 'closed', closedByName: PROBE_USER })
    expect(await respondToCodingQuery(q, 'Left again', PI)).toEqual({ ok: false, error: 'query_closed' })
    expect(await closeCodingQuery(q, 'withdraw', CODER)).toEqual({ ok: false, error: 'query_closed' })
    const a = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['coding: raised query', 'coding: responded to query', 'coding: closed query']))
    for (const x of a) {
      expect(`${x.action} ${x.details}`).not.toMatch(/Laterality|Left/)
      expect(x.patientId).toBe(PATIENT)
    }
  })

  it('withdraw, unknown query, inactive doctor, finalised and claim rules', async () => {
    const q = qid(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Q1' }, CODER))
    expect(await closeCodingQuery(q, 'withdraw', CODER_B)).toEqual({ ok: false, error: 'not_claimed' })
    expect(await closeCodingQuery(q, 'withdraw', CODER)).toEqual({ ok: true, value: { status: 'withdrawn' } })
    expect((await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).map((x) => x.action)).toContain('coding: withdrew query')
    expect(await respondToCodingQuery(2147483000, 'x', PI)).toEqual({ ok: false, error: 'query_not_found' })
    expect(await closeCodingQuery(2147483000, 'close', ADMIN)).toEqual({ ok: false, error: 'query_not_found' })
    expect(await raiseCodingQuery(enc.id, { addressedToProviderId: 2147483000, question: 'Q' }, CODER)).toEqual({ ok: false, error: 'provider_not_found' })
    await getDb().update(providers).set({ isActive: false }).where(eq(providers.id, otherDocId))
    try {
      expect(await raiseCodingQuery(enc.id, { addressedToProviderId: otherDocId, question: 'Q' }, CODER)).toEqual({ ok: false, error: 'provider_not_found' })
    } finally {
      await getDb().update(providers).set({ isActive: true }).where(eq(providers.id, otherDocId))
    }
    expect(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Q' }, CODER_B)).toEqual({ ok: false, error: 'not_claimed' })
    expect(await raiseCodingQuery(2147483000, { addressedToProviderId: docId, question: 'Q' }, CODER)).toEqual({ ok: false, error: 'not_found' })
    const open = await makeEncounter('in_consultation')
    expect(await raiseCodingQuery(open.id, { addressedToProviderId: docId, question: 'Q' }, ADMIN)).toEqual({ ok: false, error: 'encounter_not_completed' })

    // Finalised: no new query.
    expect((await applyCodingAction(enc.id, { action: 'resume' }, CODER)).ok).toBe(true)
    await addEncounterDiagnosis(enc.id, { codeId, type: 'primary' }, CODER)
    expect((await applyCodingAction(enc.id, { action: 'mark_coded' }, CODER)).ok).toBe(true)
    expect((await applyCodingAction(enc.id, { action: 'finalise' }, CODER)).ok).toBe(true)
    expect(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Q' }, CODER)).toEqual({ ok: false, error: 'invalid_transition' })
    expect(await getDb().select().from(codingQueries).where(eq(codingQueries.encounterId, enc.id))).toHaveLength(1)
  })

  it('lists open queries for the addressed doctor only, oldest first', async () => {
    const q1 = qid(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'First?' }, CODER))
    const q2 = qid(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Second?' }, CODER))
    const q3 = qid(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'Third?' }, CODER))
    await respondToCodingQuery(q3, 'Done', PI)
    const list = await listOpenCodingQueriesForProvider(docId)
    expect(list.map((q) => q.queryId)).toEqual([q1, q2])
    expect(list[0]).toEqual({
      queryId: q1, encounterId: enc.id, patientId: PATIENT, patientName: 'TEST_SP6 Query Patient', uhid: `TSP6Q${RUN}`,
      encounterDate: '2099-03-01', question: 'First?', raisedByName: PROBE_USER, raisedAt: expect.any(Date),
    })
    expect(await listOpenCodingQueriesForProvider(otherDocId)).toEqual([])
  })
})
