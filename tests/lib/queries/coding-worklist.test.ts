// SP6 Task 10: the coding worklist and the productivity/backlog report against the real local
// Postgres. Fixtures: a TEST department, doctor, patient (with contact values set, to prove the
// rows never carry them), two TEST coder users, and SP3 encounters completed in 2099 so no real
// row can fall in the filtered range. Every fixture is deleted by id, children first.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  codeSystems, codes, codingQueries, departments, diagnoses, encounterCoding, encounterCodingEvents, encounters, patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { CodingWorklistFilters } from '@/lib/coding/worklist'
import type { CodingEventAction, EncounterCodingStatus } from '@/lib/coding/status'
import { getCodingProductivity, listCodingWorklist } from '@/lib/queries/coding-worklist'

const RUN = `${Date.now()}`.slice(-8)
const PROBE = `TEST-SP6-T10-${RUN}`
const PATIENT = `TEST-SP6-${RUN}-P10`
const DEPT_CODE = `TSP6W${RUN}`
const NOW = new Date('2099-03-10T06:00:00Z') // 11:30 IST on 2099-03-10

let deptId = 0
let providerId = 0
let coderAId = 0
let coderBId = 0
let systemId = 0
let codeId = 0
let CODER_A: Session
let CODER_B: Session

describe.skipIf(!process.env.DATABASE_URL)('coding worklist and productivity (DB)', () => {
  const encounterIds: number[] = []
  let F: CodingWorklistFilters

  async function enc(completedAt: string | null, opts: { status?: 'completed' | 'in_consultation'; type?: 'opd' | 'ipd' } = {}) {
    const status = opts.status ?? 'completed'
    const [e] = await getDb().insert(encounters).values({
      patientId: PATIENT, encounterType: opts.type ?? 'opd', status, encounterDate: (completedAt ?? '2099-03-01').slice(0, 10),
      providerId, departmentId: deptId, checkedInByName: PROBE, completedAt: completedAt ? new Date(completedAt) : null,
    }).returning({ id: encounters.id })
    encounterIds.push(e.id)
    return e.id
  }
  async function coding(encounterId: number, status: EncounterCodingStatus, assignedToUserId: number | null = null) {
    await getDb().insert(encounterCoding).values({
      encounterId, patientId: PATIENT, status, assignedToUserId, assignedToName: assignedToUserId ? PROBE : null,
      finalisedAt: status === 'finalised' ? NOW : null, finalisedByName: status === 'finalised' ? PROBE : null,
    })
  }
  async function event(encounterId: number, action: CodingEventAction, byName: string, at: string, byUserId: number | null = null) {
    await getDb().insert(encounterCodingEvents).values({
      encounterId, action, fromStatus: 'in_progress', toStatus: 'in_progress', byName, byUserId, at: new Date(at),
    })
  }

  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_SP6 Coding dept', kind: 'clinical' }).returning()
    deptId = d.id
    const [p] = await db.insert(providers).values({ name: `TEST_SP6 Dr Worklist ${RUN}`, specialty: 'Test', colorTag: '#000000', departmentId: d.id }).returning()
    providerId = p.id
    await db.insert(patients).values({
      id: PATIENT, name: 'TEST_SP6 Worklist Patient', dob: '1980-05-05', gender: 'female', uhid: `TSP6L${RUN}`,
      phone: '+919800000010', email: `test-sp6-${RUN}-wl@example.invalid`, addressLine1: 'TEST 10 Example Road', pinCode: '560010',
    })
    const [a] = await db.insert(users).values({ name: `${PROBE} Coder A`, email: `test-sp6-${RUN}-wa@example.invalid`, role: 'coder' }).returning()
    const [b] = await db.insert(users).values({ name: `${PROBE} Coder B`, email: `test-sp6-${RUN}-wb@example.invalid`, role: 'coder' }).returning()
    coderAId = a.id
    coderBId = b.id
    CODER_A = { role: 'coder', name: `${PROBE} Coder A`, userId: a.id }
    CODER_B = { role: 'coder', name: `${PROBE} Coder B`, userId: b.id }
    const [cs] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `TEST-SP6-${RUN}-wl`, name: 'TEST fictional set', licenceNote: 'Test licence', sourceFileName: 'test.csv',
      sourceSha256: 'x', codeCount: 1, importedByName: PROBE,
    }).returning()
    systemId = cs.id
    const [c] = await db.insert(codes).values({ codeSystemId: cs.id, code: 'U1Z.0', display: 'TEST fictional U1Z.0' }).returning()
    codeId = c.id
    F = { status: 'pending', assignee: 'all', encounterType: null, departmentId: deptId, fromDate: '2099-03-01', toDate: '2099-03-31', page: 1 }
  })

  afterEach(async () => {
    const db = getDb()
    const ids = encounterIds.splice(0)
    if (!ids.length) return
    await db.delete(codingQueries).where(inArray(codingQueries.encounterId, ids))
    await db.delete(encounterCodingEvents).where(inArray(encounterCodingEvents.encounterId, ids))
    await db.delete(encounterCoding).where(inArray(encounterCoding.encounterId, ids))
    await db.delete(diagnoses).where(inArray(diagnoses.encounterId, ids))
    await db.delete(encounters).where(inArray(encounters.id, ids))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(codes).where(eq(codes.codeSystemId, systemId))
    await db.delete(codeSystems).where(eq(codeSystems.id, systemId))
    await db.delete(users).where(inArray(users.id, [coderAId, coderBId]))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(patients).where(eq(patients.id, PATIENT))
  })

  it('lists completed encounters awaiting coding, oldest first, with counts', async () => {
    const newer = await enc('2099-03-05T05:00:00Z')
    await coding(newer, 'in_progress', coderAId)
    const older = await enc('2099-03-02T05:00:00Z') // no coding row: reads uncoded
    await enc(null, { status: 'in_consultation' })
    const done = await enc('2099-03-03T05:00:00Z')
    await coding(done, 'finalised')
    const db = getDb()
    await db.insert(diagnoses).values([
      { patientId: PATIENT, code: '', description: 'TEST free text', encounterId: newer, codingStatus: 'uncoded', diagnosisType: 'secondary' },
      { patientId: PATIENT, code: 'U1Z.0', description: 'TEST proposed', encounterId: newer, codingStatus: 'proposed', diagnosisType: 'primary', codeId, codeSystemKind: 'icd10' },
      { patientId: PATIENT, code: 'U1Z.1', description: 'TEST voided', encounterId: newer, codingStatus: 'uncoded', diagnosisType: 'secondary', voidedAt: NOW },
    ])
    await db.insert(codingQueries).values([
      { encounterId: newer, patientId: PATIENT, addressedToProviderId: providerId, question: 'TEST q', raisedByName: PROBE },
      { encounterId: newer, patientId: PATIENT, addressedToProviderId: providerId, question: 'TEST q2', raisedByName: PROBE, status: 'closed' },
    ])

    const { rows, total, counts } = await listCodingWorklist(F, CODER_A, NOW)
    expect(rows.map((r) => r.encounterId)).toEqual([older, newer])
    expect(total).toBe(2)
    expect(counts).toEqual({ uncoded: 1, in_progress: 1, queried: 0, coded: 0, finalised: 1 })
    expect(rows[0]).toMatchObject({
      encounterType: 'opd', codingStatus: 'uncoded', assignedToUserId: null, assignedToName: null, completedIstDate: '2099-03-02',
      patientId: PATIENT, patientName: 'TEST_SP6 Worklist Patient', uhid: `TSP6L${RUN}`, departmentName: 'TEST_SP6 Coding dept',
      providerName: `TEST_SP6 Dr Worklist ${RUN}`, uncodedCount: 0, proposedCount: 0, openQueryCount: 0, ageBucket: '8-30',
    })
    expect(rows[1]).toMatchObject({
      codingStatus: 'in_progress', assignedToUserId: coderAId, uncodedCount: 1, proposedCount: 1, openQueryCount: 1, ageBucket: '3-7',
    })
    expect(rows[1].completedAt).toEqual(new Date('2099-03-05T05:00:00Z'))

    const finalised = await listCodingWorklist({ ...F, status: 'finalised' }, CODER_A, NOW)
    expect(finalised.rows.map((r) => r.encounterId)).toEqual([done])
    expect(finalised.total).toBe(1)
    expect(finalised.counts).toEqual(counts) // counts ignore the status filter
    expect((await listCodingWorklist({ ...F, status: 'uncoded' }, CODER_A, NOW)).rows.map((r) => r.encounterId)).toEqual([older])
    expect((await listCodingWorklist({ ...F, encounterType: 'ipd' }, CODER_A, NOW)).total).toBe(0)
  })

  it('worklist rows carry no contact fields', async () => {
    await enc('2099-03-02T05:00:00Z')
    const { rows } = await listCodingWorklist(F, CODER_A, NOW)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual([
      'ageBucket', 'assignedToName', 'assignedToUserId', 'codingStatus', 'completedAt', 'completedIstDate', 'departmentName',
      'encounterDate', 'encounterId', 'encounterType', 'openQueryCount', 'patientId', 'patientName', 'proposedCount', 'providerName',
      'uhid', 'uncodedCount',
    ])
    const json = JSON.stringify(rows)
    expect(json).not.toMatch(/"(phone|email|dob|address\w*|pinCode|abha\w*|gender)"/)
    for (const v of ['+919800000010', `test-sp6-${RUN}-wl@example.invalid`, 'TEST 10 Example Road', '1980-05-05']) expect(json).not.toContain(v)
  })

  it('mine and unassigned filter by the claim', async () => {
    const a = await enc('2099-03-02T05:00:00Z')
    await coding(a, 'in_progress', coderAId)
    const b = await enc('2099-03-03T05:00:00Z')
    await coding(b, 'queried', coderBId)
    const free = await enc('2099-03-04T05:00:00Z')
    const freeWithRow = await enc('2099-03-06T05:00:00Z')
    await coding(freeWithRow, 'in_progress', null)

    expect((await listCodingWorklist({ ...F, assignee: 'mine' }, CODER_A, NOW)).rows.map((r) => r.encounterId)).toEqual([a])
    expect((await listCodingWorklist({ ...F, assignee: 'mine' }, CODER_B, NOW)).rows.map((r) => r.encounterId)).toEqual([b])
    expect((await listCodingWorklist({ ...F, assignee: 'unassigned' }, CODER_A, NOW)).rows.map((r) => r.encounterId)).toEqual([free, freeWithRow])
    expect((await listCodingWorklist(F, CODER_A, NOW)).total).toBe(4)
    const envAdmin: Session = { role: 'admin', name: PROBE, userId: null }
    const mine = await listCodingWorklist({ ...F, assignee: 'mine' }, envAdmin, NOW)
    expect(mine.rows).toEqual([])
    expect(mine.total).toBe(0)
    expect(mine.counts).toEqual({ uncoded: 0, in_progress: 0, queried: 0, coded: 0, finalised: 0 })
  })

  it('a 00:30 IST completion counts on that IST day for date filters', async () => {
    const e = await enc('2099-03-04T19:00:00Z') // 2099-03-05 00:30 IST
    const day = (d: string) => listCodingWorklist({ ...F, fromDate: d, toDate: d }, CODER_A, NOW)
    const on5 = await day('2099-03-05')
    expect(on5.rows.map((r) => r.encounterId)).toEqual([e])
    expect(on5.rows[0].completedIstDate).toBe('2099-03-05')
    expect((await day('2099-03-04')).total).toBe(0)
    expect((await listCodingWorklist({ ...F, fromDate: null, toDate: '2099-03-04' }, CODER_A, NOW)).rows.map((r) => r.encounterId)).not.toContain(e)
    expect((await listCodingWorklist({ ...F, fromDate: '2099-03-05', toDate: null }, CODER_A, NOW)).rows.map((r) => r.encounterId)).toEqual([e])
  })

  it('pages 50 rows at a time with the raw total', async () => {
    const db = getDb()
    const rows = await db.insert(encounters).values(Array.from({ length: 52 }, (_, i) => ({
      patientId: PATIENT, encounterType: 'opd' as const, status: 'completed' as const, encounterDate: '2099-03-02',
      providerId, departmentId: deptId, checkedInByName: PROBE, completedAt: new Date(Date.UTC(2099, 2, 2, 5, i)),
    }))).returning({ id: encounters.id })
    encounterIds.push(...rows.map((r) => r.id))
    const p1 = await listCodingWorklist(F, CODER_A, NOW)
    const p2 = await listCodingWorklist({ ...F, page: 2 }, CODER_A, NOW)
    expect(p1.rows).toHaveLength(50)
    expect(p2.rows.map((r) => r.encounterId)).toEqual(rows.slice(50).map((r) => r.id))
    expect(p1.total).toBe(52)
    expect(p2.total).toBe(52)
  })

  it('productivity counts events per coder and the median time to finalise', async () => {
    const e1 = await enc('2099-03-02T04:30:00Z')
    await coding(e1, 'finalised', coderAId)
    const e2 = await enc('2099-03-03T00:00:00Z')
    await coding(e2, 'finalised', coderAId)
    const e3 = await enc('2099-03-05T05:00:00Z')
    await coding(e3, 'in_progress', coderBId)
    await enc('2099-03-09T05:00:00Z') // backlog, 1 day old on NOW
    const A = `${PROBE} Coder A`
    const B = `${PROBE} Coder B`
    await event(e1, 'claim', A, '2099-03-02T05:00:00Z', coderAId)
    await event(e1, 'mark_coded', A, '2099-03-02T06:00:00Z', coderAId)
    await event(e1, 'finalise', A, '2099-03-02T10:30:00Z', coderAId) // 6 h after completion
    await event(e2, 'claim', A, '2099-03-03T00:30:00Z', coderAId)
    await event(e2, 'raise_query', A, '2099-03-03T00:40:00Z', coderAId)
    await event(e2, 'mark_coded', A, '2099-03-03T01:00:00Z', coderAId)
    await event(e2, 'finalise', A, '2099-03-03T02:00:00Z', coderAId) // 2 h
    await event(e2, 'reopen', A, '2099-03-03T03:00:00Z', coderAId)
    await event(e3, 'claim', B, '2099-03-05T06:00:00Z', coderBId)
    await event(e3, 'mark_coded', B, '2099-04-15T06:00:00Z', coderBId) // outside the range

    const p = await getCodingProductivity({ from: '2099-03-01', to: '2099-03-31' }, NOW)
    expect(p.from).toBe('2099-03-01')
    expect(p.to).toBe('2099-03-31')
    const mine = p.perCoder.filter((c) => c.name.startsWith(PROBE))
    expect(mine).toEqual([
      { userId: coderAId, name: A, claimed: 2, coded: 2, finalised: 2, queriesRaised: 1, reopened: 1, medianHoursToFinalise: 4 },
      { userId: coderBId, name: B, claimed: 1, coded: 0, finalised: 0, queriesRaised: 0, reopened: 0, medianHoursToFinalise: null },
    ])
    // The range edge is an IST day: e2's events (from 06:00 IST on 2099-03-03) fall outside a range ending 2099-03-02.
    const early = await getCodingProductivity({ from: '2099-03-01', to: '2099-03-02' }, NOW)
    expect(early.perCoder.find((c) => c.name === A)).toEqual({ userId: coderAId, name: A, claimed: 1, coded: 1, finalised: 1, queriesRaised: 0, reopened: 0, medianHoursToFinalise: 6 })

    // Backlog: every non-finalised completed encounter; real rows are years older than NOW.
    expect(p.backlog.byStatus.finalised).toBe(0)
    expect(p.backlog.byStatus.in_progress).toBeGreaterThanOrEqual(1)
    expect(p.backlog.byAge['0-2']).toBe(1)
    expect(p.backlog.byAge['3-7']).toBe(1)
    expect(p.backlog.oldestCompletedDate! <= '2099-03-05').toBe(true)
  })

  it('productivity groups by user account, not by display name', async () => {
    const e1 = await enc('2099-03-02T04:30:00Z')
    const e2 = await enc('2099-03-03T04:30:00Z')
    const SAME = `${PROBE} Same Name`
    // Two different coders sharing one display name stay two rows.
    await event(e1, 'claim', SAME, '2099-03-02T05:00:00Z', coderAId)
    await event(e2, 'claim', SAME, '2099-03-03T05:00:00Z', coderBId)
    // One coder renamed mid-period stays one row, under the latest name.
    await event(e1, 'mark_coded', `${PROBE} Renamed A`, '2099-03-04T05:00:00Z', coderAId)

    const p = await getCodingProductivity({ from: '2099-03-01', to: '2099-03-31' }, NOW)
    const mine = p.perCoder.filter((c) => c.name.startsWith(PROBE))
    expect(mine).toHaveLength(2)
    expect(mine.find((c) => c.userId === coderAId)).toMatchObject({ name: `${PROBE} Renamed A`, claimed: 1, coded: 1 })
    expect(mine.find((c) => c.userId === coderBId)).toMatchObject({ name: SAME, claimed: 1, coded: 0 })
  })

  it('a completed visit with no completed_at is still listed, dated by its status change', async () => {
    const db = getDb()
    const [e] = await db.insert(encounters).values({
      patientId: PATIENT, encounterType: 'opd', status: 'completed', encounterDate: '2099-03-04',
      providerId, departmentId: deptId, checkedInByName: PROBE, completedAt: null,
      checkedInAt: new Date('2099-03-04T04:00:00Z'), statusChangedAt: new Date('2099-03-04T19:00:00Z'), // 2099-03-05 00:30 IST
    }).returning({ id: encounters.id })
    encounterIds.push(e.id)

    const { rows, total } = await listCodingWorklist(F, CODER_A, NOW)
    expect(rows.map((r) => r.encounterId)).toEqual([e.id])
    expect(total).toBe(1)
    expect(rows[0].completedAt).toEqual(new Date('2099-03-04T19:00:00Z'))
    expect(rows[0].completedIstDate).toBe('2099-03-05')
    expect((await listCodingWorklist({ ...F, fromDate: '2099-03-05', toDate: '2099-03-05' }, CODER_A, NOW)).total).toBe(1)
    expect((await listCodingWorklist({ ...F, fromDate: '2099-03-04', toDate: '2099-03-04' }, CODER_A, NOW)).total).toBe(0)

    const p = await getCodingProductivity({ from: '2099-03-01', to: '2099-03-31' }, NOW)
    expect(p.backlog.byAge['3-7']).toBeGreaterThanOrEqual(1)
  })
})
