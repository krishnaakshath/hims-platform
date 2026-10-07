// Coding workspace and chart loaders (SP6 Task 8) against the real local Postgres. The fixture
// patient carries phone, email, address, PIN and ABHA values so the test can prove the coder
// payload never includes them (ruling 4). Every fixture is deleted by id, children first;
// audit rows by this run's unique probe user name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  appointments, auditLog, codeSystems, codes, codingQueries, codingQueryResponses, diagnoses, encounterCoding, encounterCodingEvents,
  encounterNotes, encounterProcedures, encounters, patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  addEncounterDiagnosis, addEncounterProcedure, applyCodingAction, voidEncounterDiagnosis,
} from '@/lib/queries/coding'
import { closeCodingQuery, raiseCodingQuery, respondToCodingQuery } from '@/lib/queries/coding-queries'
import { getCodingWorkspace, listEncounterCodingForPatient } from '@/lib/queries/coding-workspace'

const RUN = `${Date.now()}`.slice(-8)
const PROBE_USER = `TEST-SP6-T8W-${Date.now()}`
const PATIENT = `TEST-SP6-${RUN}-PW`
const DOB = '1985-06-15'

let docId = 0
let coderId = 0
let dxSystemId = 0
let pcsSystemId = 0
const C: Record<string, number> = {}
const appointmentIds: number[] = []
const encounterIds: number[] = []
let enc: { id: number }
let newer: { id: number }
let cancelled: { id: number }
let bare: { id: number }
let primaryId = 0
let secondaryId = 0
let voidedId = 0
let procedureId = 0
let openQueryId = 0
let closedQueryId = 0
let signedNoteId = 0
let draftNoteId = 0
let otherVisitNoteId = 0

describe.skipIf(!process.env.DATABASE_URL)('coding workspace and chart loaders (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({
      id: PATIENT, name: 'TEST_SP6 Workspace Patient', dob: DOB, gender: 'male', uhid: `TSP6W${RUN}`,
      phone: '+919800000001', email: `test-sp6-${RUN}@example.invalid`, addressLine1: 'TEST 1 Example Road', pinCode: '560001',
      abhaNumber: `91${RUN}0001`.slice(0, 14),
    })
    const [d] = await db.insert(providers).values({ name: 'TEST_SP6 Dr Workspace', specialty: 'Test', colorTag: '#000000' }).returning()
    docId = d.id
    const [u] = await db.insert(users).values({ name: 'TEST_SP6 Workspace Coder', email: `test-sp6-${RUN}-wc@example.invalid`, role: 'coder' }).returning()
    coderId = u.id
    const [dxs] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `TEST-SP6-${RUN}-w`, name: 'TEST fictional set', licenceNote: 'Test licence', sourceFileName: 'test.csv',
      sourceSha256: 'x', codeCount: 3, importedByName: PROBE_USER,
    }).returning()
    dxSystemId = dxs.id
    const [pcs] = await db.insert(codeSystems).values({
      kind: 'icd10pcs', version: `SAMPLE-TEST-SP6-${RUN}-w`, name: 'TEST sample set', isSample: true, sourceFileName: 'test.csv',
      sourceSha256: 'x', codeCount: 1, importedByName: PROBE_USER,
    }).returning()
    pcsSystemId = pcs.id
    for (const r of await db.insert(codes).values([
      { codeSystemId: dxs.id, code: 'U7Z.0', display: 'TEST fictional U7Z.0' },
      { codeSystemId: dxs.id, code: 'U8Z.1', display: 'TEST fictional U8Z.1' },
      { codeSystemId: dxs.id, code: 'U9Z.0', display: 'TEST fictional U9Z.0' },
      { codeSystemId: pcs.id, code: 'ZZ00000', display: 'SAMPLE fictional ZZ00000' },
    ]).returning()) C[r.code] = r.id

    const appt = async (iso: string) => {
      const startsAt = new Date(iso)
      const [a] = await db.insert(appointments).values({
        patientId: PATIENT, providerId: docId, startsAt, endsAt: new Date(startsAt.getTime() + 15 * 60000), visitReason: 'TEST_SP6 visit',
      }).returning({ id: appointments.id })
      appointmentIds.push(a.id)
      return a.id
    }
    const visit = async (date: string, status: 'completed' | 'cancelled', appointmentId: number | null) => {
      const [e] = await db.insert(encounters).values({
        patientId: PATIENT, encounterType: 'opd', status, encounterDate: date, providerId: docId, appointmentId,
        checkedInByName: PROBE_USER, completedAt: status === 'completed' ? new Date(`${date}T08:00:00Z`) : null,
      }).returning({ id: encounters.id })
      encounterIds.push(e.id)
      return e
    }
    const a1 = await appt('2099-03-01T04:00:00Z')
    const a2 = await appt('2099-03-05T04:00:00Z')
    enc = await visit('2099-03-01', 'completed', a1)
    newer = await visit('2099-03-05', 'completed', a2)
    cancelled = await visit('2099-03-06', 'cancelled', null)
    bare = await visit('2099-03-07', 'completed', null)

    const note = async (appointmentId: number, status: 'signed' | 'draft', subjective: string) => {
      const [n] = await db.insert(encounterNotes).values({
        patientId: PATIENT, appointmentId, authorName: PROBE_USER, authorRole: 'pi', subjective, assessment: 'TEST assessment', status,
        signedAt: status === 'signed' ? new Date('2099-03-01T09:00:00Z') : null,
      }).returning({ id: encounterNotes.id })
      return n.id
    }
    signedNoteId = await note(a1, 'signed', 'TEST signed subjective')
    draftNoteId = await note(a1, 'draft', 'TEST draft subjective')
    otherVisitNoteId = await note(a2, 'signed', 'TEST other visit subjective')

    const PI: Session = { role: 'pi', name: PROBE_USER, userId: null }
    const CODER: Session = { role: 'coder', name: PROBE_USER, userId: coderId }
    const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value }
    secondaryId = ok(await addEncounterDiagnosis(enc.id, { codeId: C['U8Z.1'], type: 'secondary', sequence: 1 }, PI)).diagnosisId
    primaryId = ok(await addEncounterDiagnosis(enc.id, { codeId: C['U7Z.0'], type: 'primary', description: 'Doctor wording' }, PI)).diagnosisId
    voidedId = ok(await addEncounterDiagnosis(enc.id, { codeId: C['U9Z.0'], type: 'secondary', sequence: 2 }, PI)).diagnosisId
    ok(await voidEncounterDiagnosis(enc.id, voidedId, PI))
    procedureId = ok(await addEncounterProcedure(enc.id, { codeId: C['ZZ00000'], performedOn: '2026-03-01', performedByProviderId: docId }, PI)).procedureId
    ok(await applyCodingAction(enc.id, { action: 'claim' }, CODER))
    openQueryId = ok(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'TEST open question' }, CODER)).queryId
    ok(await respondToCodingQuery(openQueryId, 'TEST reply', PI))
    closedQueryId = ok(await raiseCodingQuery(enc.id, { addressedToProviderId: docId, question: 'TEST closed question' }, CODER)).queryId
    ok(await closeCodingQuery(closedQueryId, 'close', CODER))
    ok(await addEncounterDiagnosis(newer.id, { description: 'TEST newer free text', type: 'provisional' }, PI))
  })

  afterAll(async () => {
    const db = getDb()
    const qs = await db.select({ id: codingQueries.id }).from(codingQueries).where(inArray(codingQueries.encounterId, encounterIds))
    if (qs.length) await db.delete(codingQueryResponses).where(inArray(codingQueryResponses.queryId, qs.map((q) => q.id)))
    await db.delete(codingQueries).where(inArray(codingQueries.encounterId, encounterIds))
    await db.delete(encounterCodingEvents).where(inArray(encounterCodingEvents.encounterId, encounterIds))
    await db.delete(encounterCoding).where(inArray(encounterCoding.encounterId, encounterIds))
    await db.delete(encounterProcedures).where(inArray(encounterProcedures.encounterId, encounterIds))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    await db.delete(encounterNotes).where(inArray(encounterNotes.id, [signedNoteId, draftNoteId, otherVisitNoteId]))
    await db.delete(encounters).where(inArray(encounters.id, encounterIds))
    await db.delete(appointments).where(inArray(appointments.id, appointmentIds))
    await db.delete(codes).where(inArray(codes.codeSystemId, [dxSystemId, pcsSystemId]))
    await db.delete(codeSystems).where(inArray(codeSystems.id, [dxSystemId, pcsSystemId]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(users).where(eq(users.id, coderId))
    await db.delete(providers).where(eq(providers.id, docId))
    await db.delete(patients).where(eq(patients.id, PATIENT))
  })

  it('workspace patient header carries only id, name, uhid, gender, ageYears', async () => {
    const w = await getCodingWorkspace(enc.id)
    expect(Object.keys(w!.patient).sort()).toEqual(['ageYears', 'gender', 'id', 'name', 'uhid'])
    expect(w!.patient).toEqual({ id: PATIENT, name: 'TEST_SP6 Workspace Patient', uhid: `TSP6W${RUN}`, gender: 'male', ageYears: 113 })
    const json = JSON.stringify(w)
    expect(json).not.toMatch(/"(dob|phone|email|addressLine1|addressLine2|pinCode|abhaNumber|abhaAddress|city|zip|district|aadhaar\w*|primaryMemberId|primaryPayerId)"/i)
    for (const v of [DOB, '+919800000001', `test-sp6-${RUN}@example.invalid`, 'TEST 1 Example Road', '560001']) expect(json).not.toContain(v)
    expect(await getCodingWorkspace(2147483000)).toBeNull()
  })

  it('workspace carries the visit, coding state, live entries, queries, events and finalise issues', async () => {
    const w = (await getCodingWorkspace(enc.id))!
    expect(w.encounter).toMatchObject({ id: enc.id, encounterType: 'opd', status: 'completed', encounterDate: '2099-03-01', providerId: docId, providerName: 'TEST_SP6 Dr Workspace', admissionId: null, departmentName: null })
    expect(w.coding).toMatchObject({ status: 'queried', assignedToUserId: coderId, assignedToName: PROBE_USER, reopenCount: 0, finalisedAt: null })
    expect(w.diagnoses.map((d) => d.id)).toEqual([primaryId, secondaryId])
    expect(w.diagnoses[0]).toEqual({
      id: primaryId, description: 'Doctor wording', type: 'primary', codingStatus: 'proposed', sequence: null, proposedByName: PROBE_USER, codedByName: null,
      codeId: C['U7Z.0'], kind: 'icd10', code: 'U7Z.0', display: 'TEST fictional U7Z.0', version: `TEST-SP6-${RUN}-w`, isSample: false,
    })
    expect(w.procedures).toEqual([{
      id: procedureId, description: 'SAMPLE fictional ZZ00000', codingStatus: 'proposed', performedOn: '2026-03-01', performedByName: 'TEST_SP6 Dr Workspace',
      serviceId: null, serviceName: null, sequence: null, proposedByName: PROBE_USER,
      codeId: C['ZZ00000'], kind: 'icd10pcs', code: 'ZZ00000', display: 'SAMPLE fictional ZZ00000', version: `SAMPLE-TEST-SP6-${RUN}-w`, isSample: true,
    }])
    expect(w.queries.map((q) => [q.id, q.status])).toEqual([[openQueryId, 'answered'], [closedQueryId, 'closed']])
    expect(w.queries[0]).toMatchObject({ question: 'TEST open question', addressedToProviderId: docId, addressedToName: 'TEST_SP6 Dr Workspace', raisedByName: PROBE_USER })
    expect(w.queries[0].responses).toEqual([{ id: expect.any(Number), authorName: PROBE_USER, authorRole: 'pi', body: 'TEST reply', createdAt: expect.any(Date) }])
    expect(w.events.map((e) => e.action)).toEqual(['claim', 'raise_query', 'raise_query'])
    expect(w.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['not_coded']))
    expect(w.issues.every((i) => i.entry === null || [primaryId, secondaryId, procedureId].includes(i.entry.id))).toBe(true)
  })

  it('workspace shows only signed notes of this visit', async () => {
    const w = (await getCodingWorkspace(enc.id))!
    expect(w.notes.map((n) => n.id)).toEqual([signedNoteId])
    expect(w.notes[0]).toEqual({
      id: signedNoteId, noteType: 'progress', authorName: PROBE_USER, signedAt: expect.any(Date),
      subjective: 'TEST signed subjective', objective: null, assessment: 'TEST assessment', plan: null,
    })
    expect((await getCodingWorkspace(newer.id))!.notes.map((n) => n.id)).toEqual([otherVisitNoteId])
    const b = (await getCodingWorkspace(bare.id))!
    expect(b.notes).toEqual([])
    expect(b.coding).toMatchObject({ status: 'uncoded', assignedToUserId: null, reopenCount: 0 })
  })

  it('chart loader lists non-cancelled encounters newest first with live entries only', async () => {
    const list = await listEncounterCodingForPatient(PATIENT)
    expect(list.map((e) => e.encounterId)).toEqual([bare.id, newer.id, enc.id])
    expect(list.map((e) => e.encounterId)).not.toContain(cancelled.id)
    const first = list.find((e) => e.encounterId === enc.id)!
    expect(first).toMatchObject({ encounterDate: '2099-03-01', encounterType: 'opd', encounterStatus: 'completed', providerName: 'TEST_SP6 Dr Workspace', codingStatus: 'queried' })
    expect(first.diagnoses.map((d) => d.id)).toEqual([primaryId, secondaryId])
    expect(first.procedures.map((p) => p.id)).toEqual([procedureId])
    expect(first.openQueries.map((q) => q.id)).toEqual([openQueryId])
    const n = list.find((e) => e.encounterId === newer.id)!
    expect(n).toMatchObject({ codingStatus: 'uncoded' })
    expect(n.diagnoses[0]).toMatchObject({ codeId: null, kind: null, code: '', display: null, version: null, isSample: false, codingStatus: 'uncoded', description: 'TEST newer free text' })
    // Beyond the limit, a visit with an open/answered coding query is still listed (the doctor's
    // /doctor link points here for the reply), after the recent ones.
    const limited = await listEncounterCodingForPatient(PATIENT, 1)
    expect(limited.map((e) => e.encounterId)).toEqual([bare.id, enc.id])
    expect(limited[1].openQueries.map((q) => q.id)).toEqual([openQueryId])
  })
})
