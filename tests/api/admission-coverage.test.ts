// WS12 T9: coverage at OPD check-in (badge and auto-check, never blocks) and insurance at IPD
// admission (POST /api/inpatient/admissions through admitPatient's coverage hook, and
// PUT /api/admissions/[id]/coverage).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissionCoverage, admissions, auditLog, billingSettings, diagnoses, doctorAssignments, encounters, patientPolicies, preauths, rooms,
} from '@/db/schema'

const state = vi.hoisted(() => ({ role: 'frontdesk' as string, name: '' }))
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role: state.role, name: state.name, userId: null })),
  requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: state.name, userId: null })),
}))
// The automatic NHCX check is pinned as a call (its own behaviour is covered by the WS12 T4 tests).
vi.mock('@/lib/queries/coverage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/coverage')>('@/lib/queries/coverage')
  return { ...actual, maybeStartEligibility: vi.fn(async () => ({ started: false, reason: 'nhcx_not_configured', message: 'NHCX not configured: record a manual verification' })) }
})

import { POST as admitPost } from '@/app/api/inpatient/admissions/route'
import { POST as checkInPost } from '@/app/api/front-desk/check-in/route'
import { PUT as coveragePut } from '@/app/api/admissions/[id]/coverage/route'
import { maybeStartEligibility } from '@/lib/queries/coverage'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../db/rcm-fixtures'
import { purgeBillingFixtures } from '../db/billing-fixtures'
import { purgeCoverageFixtures } from '../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST_WS12T9-${RUN}`

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never
const put = (id: number, body: unknown) => coveragePut(
  new Request(`http://localhost/api/admissions/${id}/coverage`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never,
  { params: Promise.resolve({ id: String(id) }) },
)

describe.skipIf(!process.env.DATABASE_URL)('WS12 T9 admission and check-in coverage', () => {
  let b: RcmBase // base policy made expired in beforeAll
  let other: RcmBase
  let validPolicyId = 0
  let threshold = 0
  const roomIds: number[] = []

  async function room() {
    const [r] = await getDb().insert(rooms).values({ ward: `${PROBE} Ward`, roomNumber: `R${roomIds.length}`, bedNumber: 'A' }).returning()
    roomIds.push(r.id)
    return r.id
  }
  const admitBody = (roomId: number, over: Record<string, unknown> = {}) => ({
    patientId: b.patientId, attendingProviderId: b.providerId, roomId, admissionType: 'elective', reason: 'Planned surgery',
    provisionalDiagnosis: { text: 'Inguinal hernia' }, expectedStayDays: 3, attendant: null, policyId: null, preauthId: null,
    depositRequiredPaise: 0, wardGenderOverrideReason: null, openOpdVisit: 'keep', ...over,
  })
  const roomStatus = async (id: number) => (await getDb().select({ s: rooms.status }).from(rooms).where(eq(rooms.id, id)))[0].s
  const admissionRows = () => getDb().select().from(admissions).where(eq(admissions.patientId, b.patientId))
  async function preauth(base: RcmBase, policyId: number, n: string, status: 'draft' | 'rejected' = 'draft') {
    const [p] = await getDb().insert(preauths).values({
      preauthNumber: `PA-T9-${RUN}${n}`, patientId: base.patientId, policyId, insurerPayerId: base.insurerId, tpaPayerId: base.tpaId,
      claimType: 'ipd', status, plannedAdmissionDate: '2026-10-24', expectedLengthOfStayDays: 3, treatingProviderId: base.providerId,
      estimateLines: [], estimatedPaise: 0, requestedPaise: 0, createdByName: PROBE,
    }).returning()
    return p.id
  }

  beforeAll(async () => {
    state.name = PROBE
    b = await makeRcmBase(RUN, 'T9')
    other = await makeRcmBase(RUN, 'T9O')
    await getDb().update(patientPolicies).set({ validFrom: '2020-01-01', validTo: '2020-12-31' }).where(eq(patientPolicies.id, b.policyId))
    const [valid] = await getDb().insert(patientPolicies).values({
      patientId: b.patientId, insurerPayerId: b.insurerId, policyNumber: 'POL-T9V', memberId: 'MEM-T9V', policyType: 'individual',
      holderName: 'Holder', relationship: 'self', validFrom: '2020-01-01', validTo: '2099-12-31', priority: 'secondary', createdByName: PROBE,
    }).returning()
    validPolicyId = valid.id
    const [bs] = await getDb().select({ t: billingSettings.ipdDepositThresholdPaise }).from(billingSettings).where(eq(billingSettings.id, 1))
    threshold = bs?.t ?? 0
  })

  afterEach(async () => {
    const db = getDb()
    state.role = 'frontdesk'
    vi.mocked(maybeStartEligibility).mockClear()
    const admIds = (await admissionRows()).map((r) => r.id)
    await db.update(preauths).set({ admissionId: null }).where(inArray(preauths.patientId, [b.patientId, other.patientId]))
    if (admIds.length) await db.delete(admissionCoverage).where(inArray(admissionCoverage.admissionId, admIds))
    const encIds = (await db.select({ id: encounters.id }).from(encounters).where(and(eq(encounters.patientId, b.patientId), isNotNull(encounters.checkedInAt)))).map((e) => e.id)
      .filter((id) => id !== b.encounterId)
    await purgeBillingFixtures([b.patientId])
    if (encIds.length) {
      await db.delete(diagnoses).where(inArray(diagnoses.encounterId, encIds))
      await db.delete(encounters).where(inArray(encounters.id, encIds))
    }
    if (admIds.length) await db.delete(admissions).where(inArray(admissions.id, admIds))
    await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, b.patientId))
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds.splice(0)))
    await db.delete(preauths).where(inArray(preauths.patientId, [b.patientId, other.patientId]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  afterAll(async () => {
    await purgeCoverageFixtures([b.patientId, other.patientId], { dropAdmissions: true })
    await purgeBillingFixtures([b.patientId, other.patientId])
    await purgeRcmFixtures([b.patientId, other.patientId], [b.insurerId, b.tpaId, other.insurerId, other.tpaId])
    await deleteRcmBasePatient(b.patientId)
    await deleteRcmBasePatient(other.patientId)
  })

  it('OPD check-in with an expired policy: 201 with a warning verdict and an auto-check in the checkin context', async () => {
    const res = await checkInPost(post('/api/front-desk/check-in', { patientId: b.patientId, providerId: b.providerId, visitType: 'outpatient', urgency: 'routine', reason: 'Fever' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.coverage).toMatchObject({ state: 'policy_expired', severity: 'warn', policyId: b.policyId })
    expect(maybeStartEligibility).toHaveBeenCalledWith(expect.objectContaining({ policyId: b.policyId, context: 'checkin', providerId: b.providerId }), expect.anything())
  })

  it('cashless elective admission with an expired policy: 409 coverage_blocked, bed still free, no admission', async () => {
    const r1 = await room()
    const res = await admitPost(post('/api/inpatient/admissions', admitBody(r1, { policyId: b.policyId })))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'coverage_blocked', state: 'policy_expired' })
    expect(await roomStatus(r1)).toBe('available')
    expect(await admissionRows()).toHaveLength(0)
  })

  it('the same as an emergency: admitted with a warning, the coverage row records policy_expired, auto-check in the admission context', async () => {
    const r1 = await room()
    const res = await admitPost(post('/api/inpatient/admissions', admitBody(r1, { policyId: b.policyId, admissionType: 'emergency' })))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.coverage).toMatchObject({ state: 'policy_expired', severity: 'warn' })
    const [cov] = await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, body.admissionId))
    expect(cov).toMatchObject({ mode: 'cashless', policyId: b.policyId, coverageState: 'policy_expired' })
    expect(maybeStartEligibility).toHaveBeenCalledWith(expect.objectContaining({ policyId: b.policyId, context: 'admission' }), expect.anything())
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'insurance: recorded admission coverage')))
    expect(audits.map((a) => a.details)).toEqual([`admission=${body.admissionId} mode=cashless policy=${b.policyId} preauth=none state=policy_expired`])
  })

  it('reimbursement and self-pay are never blocked by the cover (the evaluator has no payment mode)', async () => {
    const r1 = await room()
    const res = await admitPost(post('/api/inpatient/admissions', admitBody(r1, { policyId: b.policyId, coverageMode: 'reimbursement' })))
    expect(res.status).toBe(201)
    const { admissionId } = await res.json()
    const [cov] = await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, admissionId))
    expect(cov).toMatchObject({ mode: 'reimbursement', policyId: b.policyId, coverageState: 'policy_expired' })
    expect((await admitPost(post('/api/inpatient/admissions', admitBody(await room(), { coverageMode: 'self_pay', policyId: b.policyId })))).status).toBe(400)
  })

  it('a rejected pre-auth is refused before the bed claim', async () => {
    const r1 = await room()
    const rejected = await preauth(b, validPolicyId, 'R', 'rejected')
    const res = await admitPost(post('/api/inpatient/admissions', admitBody(r1, { policyId: validPolicyId, preauthId: rejected })))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'preauth_closed' })
    expect(await roomStatus(r1)).toBe('available')
  })

  describe('PUT /api/admissions/[id]/coverage', () => {
    async function admitSelfPay() {
      const res = await admitPost(post('/api/inpatient/admissions', admitBody(await room())))
      expect(res.status).toBe(201)
      return (await res.json()).admissionId as number
    }

    it('403s a pi before reading the body', async () => {
      state.role = 'pi'
      const res = await put(1, '{not json')
      expect(res.status).toBe(403)
    })

    it('400s an unknown key and a self-pay body with a policy', async () => {
      const id = await admitSelfPay()
      expect((await put(id, { mode: 'self_pay', extra: 1 })).status).toBe(400)
      expect((await put(id, { mode: 'self_pay', policyId: validPolicyId })).status).toBe(400)
      expect((await put(id, { mode: 'cashless' })).status).toBe(400)
    })

    it('self-pay with no deposit given defaults to the billing threshold', async () => {
      const id = await admitSelfPay()
      const res = await put(id, { mode: 'self_pay' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.coverage).toMatchObject({ mode: 'self_pay', policyId: null, depositRequiredPaise: threshold, coverageState: 'no_policy' })
    })

    it('cashless on a valid policy links an unlinked pre-auth and defaults the deposit to 0; another patient\'s pre-auth is 409', async () => {
      const id = await admitSelfPay()
      const theirs = await preauth(other, other.policyId, 'O')
      const refused = await put(id, { mode: 'cashless', policyId: validPolicyId, preauthId: theirs })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ code: 'preauth_mismatch' })
      const mine = await preauth(b, validPolicyId, 'M')
      const res = await put(id, { mode: 'cashless', policyId: validPolicyId, preauthId: mine })
      expect(res.status).toBe(200)
      expect((await res.json()).coverage).toMatchObject({ mode: 'cashless', policyId: validPolicyId, preauthId: mine, depositRequiredPaise: 0 })
      expect((await getDb().select().from(preauths).where(eq(preauths.id, mine)))[0].admissionId).toBe(id)
    })

    it('another patient\'s policy is 404; an expired cashless policy on an elective stay is 409 coverage_blocked', async () => {
      const id = await admitSelfPay()
      expect((await put(id, { mode: 'cashless', policyId: other.policyId })).status).toBe(404)
      const blocked = await put(id, { mode: 'cashless', policyId: b.policyId })
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toMatchObject({ code: 'coverage_blocked', state: 'policy_expired' })
      const [cov] = await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, id))
      expect(cov.mode).toBe('self_pay')
    })

    it('404s after discharge', async () => {
      const id = await admitSelfPay()
      await getDb().update(admissions).set({ status: 'discharged', dischargedAt: new Date() }).where(eq(admissions.id, id))
      expect((await put(id, { mode: 'self_pay' })).status).toBe(404)
      expect((await put(999_999_999, { mode: 'self_pay' })).status).toBe(404)
    })
  })
})
