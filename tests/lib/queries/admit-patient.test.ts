// WS3 T2: admitPatient -- the one admission path (spec 3.1 items 1-11).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissionCoverage, admissions, auditLog, chargeLines, codeSystems, codes, diagnoses, doctorAssignments, encounters,
  patientPolicies, patients, preauths, providers, rooms,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { admitPatient, type AdmitPatientInput } from '@/lib/queries/admit-patient'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'

// Real logAudit by default; a test can make the audit insert itself fail (after the bed claim).
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit')
  return { ...actual, logAudit: vi.fn(actual.logAudit) }
})
import { logAudit } from '@/lib/audit'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST_WS3T2-${RUN}`
const SESSION: Session = { role: 'frontdesk', name: PROBE, userId: null }
const NOW = new Date('2099-05-01T05:00:00Z') // 10:30 IST, 2099-05-01
const TODAY = istDateOf(NOW)

describe.skipIf(!process.env.DATABASE_URL)('admitPatient (DB)', () => {
  let female: RcmBase // adult woman with an active primary policy
  let other: RcmBase // another patient (their pre-auth must not attach)
  const MALE = `TEST-WS3T2-${RUN}-M`
  const CHILD = `TEST-WS3T2-${RUN}-C`
  let providerId = 0
  let codeId = 0
  let savedCurrent: number[] = []
  const systemIds: number[] = []
  const roomIds: number[] = []

  async function room(genderRestriction: 'male' | 'female' | null = null, status: 'available' | 'occupied' | 'dirty' | 'blocked' = 'available') {
    const [r] = await getDb().insert(rooms).values({ ward: `${PROBE} Ward`, roomNumber: `R${roomIds.length}`, bedNumber: 'A', status, genderRestriction }).returning()
    roomIds.push(r.id)
    return r.id
  }
  const roomRow = async (id: number) => (await getDb().select().from(rooms).where(eq(rooms.id, id)))[0]

  const input = (over: Partial<AdmitPatientInput> & { roomId: number }): AdmitPatientInput => ({
    patientId: female.patientId, attendingProviderId: providerId, admissionType: 'emergency', reason: 'Fever with low platelets',
    provisionalDiagnosis: { text: 'Dengue fever, suspected' }, expectedStayDays: 4,
    attendant: { name: 'Ravi Kumar', relationship: 'Husband', phone: '+919876543210' },
    policyId: null, preauthId: null, depositRequiredPaise: 0, wardGenderOverrideReason: null, openOpdVisit: null, ...over,
  })

  async function preauth(base: RcmBase, n: string) {
    const [p] = await getDb().insert(preauths).values({
      preauthNumber: `PA-2099-W${RUN}${n}`, patientId: base.patientId, policyId: base.policyId, insurerPayerId: base.insurerId, tpaPayerId: base.tpaId,
      claimType: 'ipd', status: 'draft', plannedAdmissionDate: TODAY, expectedLengthOfStayDays: 3, treatingProviderId: providerId,
      estimateLines: [], estimatedPaise: 0, requestedPaise: 0, createdByName: PROBE,
    }).returning()
    return p.id
  }

  async function openOpd(patientId: string, status: 'checked_in' | 'in_consultation' = 'checked_in') {
    const [e] = await getDb().insert(encounters).values({
      patientId, encounterType: 'opd', encounterDate: TODAY, providerId, status, checkedInByName: PROBE, checkedInAt: NOW,
    }).returning()
    return e.id
  }

  beforeAll(async () => {
    const db = getDb()
    female = await makeRcmBase(RUN, 'F')
    other = await makeRcmBase(RUN, 'O')
    await db.insert(patients).values([
      { id: MALE, name: 'TEST_WS3T2 Male', dob: '1980-01-01', gender: 'male' },
      { id: CHILD, name: 'TEST_WS3T2 Child', dob: '2092-01-01', gender: 'female' }, // 7 years old on 2099-05-01
    ])
    const [p] = await db.insert(providers).values({ name: `${PROBE} Dr`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    const cur = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.isCurrent, true)))
    savedCurrent = cur.map((c) => c.id)
    if (savedCurrent.length) await db.update(codeSystems).set({ isCurrent: false }).where(inArray(codeSystems.id, savedCurrent))
    const [cs] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `TEST-WS3T2-${RUN}`, name: 'T', isSample: false, isCurrent: true, licenceNote: 'test',
      sourceFileName: 't.csv', sourceSha256: 'x', codeCount: 1, importedByName: 'test',
    }).returning({ id: codeSystems.id })
    systemIds.push(cs.id)
    const [c] = await db.insert(codes).values({ codeSystemId: cs.id, code: 'A90', display: 'Dengue fever [classical dengue]', selectable: true, active: true, excludes: [] }).returning()
    codeId = c.id
  })

  const PATIENTS = () => [female.patientId, other.patientId, MALE, CHILD]

  afterEach(async () => {
    const db = getDb()
    const pids = PATIENTS()
    const admIds = (await db.select({ id: admissions.id }).from(admissions).where(inArray(admissions.patientId, pids))).map((r) => r.id)
    if (admIds.length) {
      await db.delete(admissionCoverage).where(inArray(admissionCoverage.admissionId, admIds))
      await db.update(preauths).set({ admissionId: null }).where(inArray(preauths.admissionId, admIds))
    }
    await db.delete(preauths).where(and(inArray(preauths.patientId, pids), eq(preauths.createdByName, PROBE)))
    await db.delete(patientPolicies).where(and(inArray(patientPolicies.patientId, pids), eq(patientPolicies.createdByName, PROBE)))
    await db.delete(diagnoses).where(inArray(diagnoses.patientId, pids))
    await db.delete(chargeLines).where(inArray(chargeLines.patientId, pids))
    await db.delete(encounters).where(and(inArray(encounters.patientId, pids), eq(encounters.checkedInByName, PROBE)))
    if (admIds.length) await db.delete(admissions).where(inArray(admissions.id, admIds))
    await db.delete(doctorAssignments).where(inArray(doctorAssignments.patientId, pids))
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
    vi.mocked(logAudit).mockClear()
  })

  afterAll(async () => {
    const db = getDb()
    await purgeRcmFixtures([female.patientId, other.patientId], [female.insurerId, female.tpaId, other.insurerId, other.tpaId])
    await deleteRcmBasePatient(female.patientId)
    await deleteRcmBasePatient(other.patientId)
    await db.delete(patients).where(inArray(patients.id, [MALE, CHILD]))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(codes).where(inArray(codes.codeSystemId, systemIds))
    await db.delete(codeSystems).where(inArray(codeSystems.id, systemIds))
    if (savedCurrent.length) await db.update(codeSystems).set({ isCurrent: true }).where(inArray(codeSystems.id, savedCurrent))
  })

  it('admits: admission, IPD encounter without a token, assignment ticket 0, bed occupied, provisional coded diagnosis, coverage row', async () => {
    const r1 = await room()
    const r = await admitPatient(input({ roomId: r1, provisionalDiagnosis: { codeId }, depositRequiredPaise: 20_000_00 }), SESSION, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.roomLabel).toBe(`${PROBE} Ward R0-A`)
    const [adm] = await getDb().select().from(admissions).where(eq(admissions.id, r.admissionId))
    expect(adm).toMatchObject({
      patientId: female.patientId, currentRoomId: r1, attendingProviderId: providerId, admissionType: 'emergency', status: 'admitted',
      expectedStayDays: 4, attendantName: 'Ravi Kumar', attendantRelationship: 'Husband', attendantPhone: '+919876543210',
      wardGenderOverrideReason: null, admittedByName: PROBE,
    })
    expect(adm.admittedAt.toISOString()).toBe(NOW.toISOString())
    const [enc] = await getDb().select().from(encounters).where(eq(encounters.id, r.encounterId))
    expect(enc).toMatchObject({ encounterType: 'ipd', opdToken: null, admissionId: r.admissionId, status: 'checked_in', encounterDate: TODAY, providerId })
    const [asg] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, enc.doctorAssignmentId!))
    expect(asg).toMatchObject({ visitType: 'inpatient', status: 'scheduled', queueTicketNumber: 0, roomId: r1 })
    expect(adm.createdFromAssignmentId).toBe(asg.id)
    expect(await roomRow(r1)).toMatchObject({ status: 'occupied', occupiedByPatientId: female.patientId })
    const dx = await getDb().select().from(diagnoses).where(eq(diagnoses.encounterId, r.encounterId))
    expect(dx).toHaveLength(1)
    expect(dx[0]).toMatchObject({ diagnosisType: 'provisional', codingStatus: 'proposed', codeId, code: 'A90', codeSystemKind: 'icd10' })
    const [cov] = await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, r.admissionId))
    expect(cov).toMatchObject({ mode: 'self_pay', policyId: null, preauthId: null, depositRequiredPaise: 20_000_00, coverageState: 'no_policy', recordedByName: PROBE })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    expect(audits.map((a) => [a.action, a.details])).toContainEqual(['admitted patient', `admission=${r.admissionId} room=${r1}`])
    expect(audits.some((a) => (a.details ?? '').includes('Ravi') || a.action.includes('Fever'))).toBe(false)
  })

  it('a free-text provisional diagnosis is uncoded with an empty code', async () => {
    const r = await admitPatient(input({ roomId: await room() }), SESSION, NOW)
    if (!r.ok) throw new Error(r.error)
    const [dx] = await getDb().select().from(diagnoses).where(eq(diagnoses.encounterId, r.encounterId))
    expect(dx).toMatchObject({ diagnosisType: 'provisional', codingStatus: 'uncoded', code: '', description: 'Dengue fever, suspected', codeId: null })
  })

  it('an unknown diagnosis code is code_not_found and the bed stays free', async () => {
    const r1 = await room()
    expect(await admitPatient(input({ roomId: r1, provisionalDiagnosis: { codeId: 2147483000 } }), SESSION, NOW)).toEqual({ ok: false, error: 'code_not_found' })
    expect((await roomRow(r1)).status).toBe('available')
  })

  it('refuses a second active admission; the second room stays available', async () => {
    const [r1, r2] = [await room(), await room()]
    expect((await admitPatient(input({ roomId: r1 }), SESSION, NOW)).ok).toBe(true)
    expect(await admitPatient(input({ roomId: r2 }), SESSION, NOW)).toEqual({ ok: false, error: 'already_admitted' })
    expect(await roomRow(r2)).toMatchObject({ status: 'available', occupiedByPatientId: null })
  })

  it('two concurrent admissions of one patient: exactly one succeeds, the other room stays available', async () => {
    const [r1, r2] = [await room(), await room()]
    const rs = await Promise.all([admitPatient(input({ roomId: r1 }), SESSION, NOW), admitPatient(input({ roomId: r2 }), SESSION, NOW)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, error: 'already_admitted' })
    const winner = rs.findIndex((r) => r.ok)
    expect((await roomRow([r1, r2][1 - winner])).status).toBe('available')
    expect(await getDb().select().from(admissions).where(and(eq(admissions.patientId, female.patientId), eq(admissions.status, 'admitted')))).toHaveLength(1)
  })

  it.each(['blocked', 'dirty', 'occupied'] as const)('a %s bed is room_unavailable', async (status) => {
    const r1 = await room(null, status)
    expect(await admitPatient(input({ roomId: r1 }), SESSION, NOW)).toEqual({ ok: false, error: 'room_unavailable' })
    expect(await getDb().select().from(admissions).where(eq(admissions.patientId, female.patientId))).toHaveLength(0)
  })

  it('patient_not_found and provider_not_found', async () => {
    const r1 = await room()
    expect(await admitPatient(input({ roomId: r1, patientId: `NOPE-${RUN}` }), SESSION, NOW)).toEqual({ ok: false, error: 'patient_not_found' })
    expect(await admitPatient(input({ roomId: r1, attendingProviderId: 2147483000 }), SESSION, NOW)).toEqual({ ok: false, error: 'provider_not_found' })
    expect((await roomRow(r1)).status).toBe('available')
  })

  it('a woman into a male bed without a reason is a ward_gender_conflict and nothing is written', async () => {
    const r1 = await room('male')
    expect(await admitPatient(input({ roomId: r1 }), SESSION, NOW)).toEqual({ ok: false, error: 'ward_gender_conflict', conflict: 'opposite_sex' })
    expect((await roomRow(r1)).status).toBe('available')
    expect(await getDb().select().from(admissions).where(eq(admissions.patientId, female.patientId))).toHaveLength(0)
    expect(await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.patientId, female.patientId))).toHaveLength(0)
  })

  it('with an override reason the admission goes ahead and stores the reason and the overrider', async () => {
    const r1 = await room('male')
    const r = await admitPatient(input({ roomId: r1, wardGenderOverrideReason: 'Only bed free; family consented' }), SESSION, NOW)
    if (!r.ok) throw new Error(r.error)
    const [adm] = await getDb().select().from(admissions).where(eq(admissions.id, r.admissionId))
    expect(adm).toMatchObject({ wardGenderOverrideReason: 'Only bed free; family consented', wardGenderOverrideByName: PROBE })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    expect(audits.map((a) => [a.action, a.details])).toContainEqual(['ward gender override', `admission=${r.admissionId} room=${r1}`])
    expect(audits.some((a) => (a.details ?? '').includes('consented'))).toBe(false)
  })

  it('a patient of unrecorded gender in a restricted bed is unverified_gender; a child under 12 is exempt', async () => {
    await getDb().update(patients).set({ gender: null }).where(eq(patients.id, MALE))
    try {
      expect(await admitPatient(input({ patientId: MALE, roomId: await room('male') }), SESSION, NOW)).toEqual({ ok: false, error: 'ward_gender_conflict', conflict: 'unverified_gender' })
    } finally {
      await getDb().update(patients).set({ gender: 'male' }).where(eq(patients.id, MALE))
    }
    expect((await admitPatient(input({ patientId: CHILD, roomId: await room('male') }), SESSION, NOW)).ok).toBe(true)
    expect((await admitPatient(input({ patientId: MALE, roomId: await room('male') }), SESSION, NOW)).ok).toBe(true)
  })

  it('an open OPD visit today is open_opd_visit with its id; nothing is written', async () => {
    const opd = await openOpd(female.patientId, 'in_consultation')
    const r1 = await room()
    expect(await admitPatient(input({ roomId: r1 }), SESSION, NOW)).toEqual({ ok: false, error: 'open_opd_visit', openEncounterId: opd })
    expect((await roomRow(r1)).status).toBe('available')
  })

  it("'complete' completes the open OPD visit in the same transaction", async () => {
    const opd = await openOpd(female.patientId)
    const r = await admitPatient(input({ roomId: await room(), openOpdVisit: 'complete' }), SESSION, NOW)
    if (!r.ok) throw new Error(r.error)
    const [e] = await getDb().select().from(encounters).where(eq(encounters.id, opd))
    expect(e).toMatchObject({ status: 'completed', statusChangedByName: PROBE })
    expect(e.completedAt?.toISOString()).toBe(NOW.toISOString())
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    expect(audits.map((a) => [a.action, a.details])).toContainEqual(['completed OPD visit at admission', `encounter=${opd} admission=${r.admissionId}`])
  })

  it("'keep' leaves the open OPD visit as it was", async () => {
    const opd = await openOpd(female.patientId)
    const r = await admitPatient(input({ roomId: await room(), openOpdVisit: 'keep' }), SESSION, NOW)
    expect(r.ok).toBe(true)
    expect((await getDb().select().from(encounters).where(eq(encounters.id, opd)))[0].status).toBe('checked_in')
  })

  it('an OPD visit of another day does not block', async () => {
    await getDb().insert(encounters).values({ patientId: female.patientId, encounterType: 'opd', encounterDate: '2099-04-30', providerId, status: 'checked_in', checkedInByName: PROBE })
    expect((await admitPatient(input({ roomId: await room() }), SESSION, NOW)).ok).toBe(true)
  })

  it('a policy: someone else\'s is policy_mismatch; expired or inactive blocks a cashless elective stay (WS12 T9); the patient\'s own is recorded as cashless', async () => {
    const r1 = await room()
    expect(await admitPatient(input({ roomId: r1, policyId: other.policyId }), SESSION, NOW)).toEqual({ ok: false, error: 'policy_mismatch' })
    const [expired] = await getDb().insert(patientPolicies).values({
      patientId: female.patientId, insurerPayerId: female.insurerId, policyNumber: 'POL-EXP', memberId: 'M', policyType: 'individual',
      holderName: 'H', relationship: 'self', validFrom: '2090-01-01', validTo: '2099-04-30', priority: 'secondary', createdByName: PROBE,
    }).returning()
    expect(await admitPatient(input({ roomId: r1, policyId: expired.id, admissionType: 'elective' }), SESSION, NOW))
      .toEqual({ ok: false, error: 'coverage_blocked', coverage: expect.objectContaining({ state: 'policy_expired', severity: 'block' }) })
    await getDb().update(patientPolicies).set({ validTo: '2099-12-31', status: 'inactive' }).where(eq(patientPolicies.id, expired.id))
    expect(await admitPatient(input({ roomId: r1, policyId: expired.id, admissionType: 'elective' }), SESSION, NOW))
      .toEqual({ ok: false, error: 'coverage_blocked', coverage: expect.objectContaining({ state: 'policy_inactive', severity: 'block' }) })
    expect((await roomRow(r1)).status).toBe('available')
    const r = await admitPatient(input({ roomId: r1, policyId: female.policyId, depositRequiredPaise: 5_000_00 }), SESSION, NOW)
    if (!r.ok) throw new Error(r.error)
    const [cov] = await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, r.admissionId))
    expect(cov).toMatchObject({ mode: 'cashless', policyId: female.policyId, preauthId: null, depositRequiredPaise: 5_000_00, coverageState: 'unverified' })
  })

  it('a pre-auth: another patient\'s is preauth_mismatch; one with no policy chosen is preauth_mismatch; the patient\'s own gets admission_id', async () => {
    const r1 = await room()
    const theirs = await preauth(other, 'O')
    expect(await admitPatient(input({ roomId: r1, policyId: female.policyId, preauthId: theirs }), SESSION, NOW)).toEqual({ ok: false, error: 'preauth_mismatch' })
    const mine = await preauth(female, 'F')
    expect(await admitPatient(input({ roomId: r1, policyId: null, preauthId: mine }), SESSION, NOW)).toEqual({ ok: false, error: 'preauth_mismatch' })
    expect((await roomRow(r1)).status).toBe('available')
    const r = await admitPatient(input({ roomId: r1, policyId: female.policyId, preauthId: mine }), SESSION, NOW)
    if (!r.ok) throw new Error(r.error)
    expect((await getDb().select().from(preauths).where(eq(preauths.id, mine)))[0].admissionId).toBe(r.admissionId)
    const [cov] = await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, r.admissionId))
    expect(cov).toMatchObject({ mode: 'cashless', policyId: female.policyId, preauthId: mine })
  })

  it('a pre-auth already linked to an admission is preauth_mismatch', async () => {
    const r1 = await room()
    const mine = await preauth(female, 'L')
    const first = await admitPatient(input({ roomId: r1, policyId: female.policyId, preauthId: mine }), SESSION, NOW)
    if (!first.ok) throw new Error(first.error)
    await getDb().update(admissions).set({ status: 'discharged' }).where(eq(admissions.id, first.admissionId))
    await getDb().update(rooms).set({ status: 'available', occupiedByPatientId: null }).where(eq(rooms.id, r1))
    expect(await admitPatient(input({ roomId: r1, policyId: female.policyId, preauthId: mine }), SESSION, NOW)).toEqual({ ok: false, error: 'preauth_mismatch' })
  })

  it('an error thrown after the bed claim rolls the bed back to available', async () => {
    const r1 = await room()
    vi.mocked(logAudit).mockRejectedValueOnce(new Error('audit insert failed'))
    await expect(admitPatient(input({ roomId: r1 }), SESSION, NOW)).rejects.toThrow('audit insert failed')
    expect(await roomRow(r1)).toMatchObject({ status: 'available', occupiedByPatientId: null })
    expect(await getDb().select().from(admissions).where(eq(admissions.patientId, female.patientId))).toHaveLength(0)
  })
})
