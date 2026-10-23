import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { coverageVerifications, nhcxEligibilityChecks, patientPolicies, patients, payerProfiles } from '@/db/schema'
import { getCoverageSummary, currentVerification } from '@/lib/queries/coverage'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'
import { purgeCoverageFixtures } from '../../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const NOW = new Date('2026-10-23T06:30:00Z')
const H = 3_600_000

describe.skipIf(!process.env.DATABASE_URL)('coverage queries (DB)', () => {
  let b: RcmBase
  let secondaryId = 0
  let newestId = 0
  let pendingNewId = 0
  const barePatient = `TEST-WS12-${RUN}-BARE`
  const db = () => getDb()
  const verify = async (hoursAgo: number, over: Partial<typeof coverageVerifications.$inferInsert> = {}) => {
    const verifiedAt = new Date(NOW.getTime() - hoursAgo * H)
    const [r] = await db().insert(coverageVerifications).values({
      patientId: b.patientId, policyId: b.policyId, source: 'manual', result: 'active', context: 'manual', method: 'phone',
      verifiedByName: 'Test Desk', verifiedAt, validUntil: new Date(verifiedAt.getTime() + 24 * H), ...over,
    }).returning()
    return r.id
  }
  const check = async (hoursAgo: number, status: 'pending' | 'eligible') => {
    const [r] = await db().insert(nhcxEligibilityChecks).values({
      patientId: b.patientId, policyId: b.policyId, payerId: b.tpaId, purpose: 'validation', context: 'checkin', status, requestedByName: 'Test', requestedAt: new Date(NOW.getTime() - hoursAgo * H),
    }).returning()
    return r.id
  }

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12Q')
    await db().update(patientPolicies).set({ sumInsuredPaise: 5_00_000_00, copayBp: 1000, roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00 }).where(eq(patientPolicies.id, b.policyId))
    await db().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}@sbx` }).where(eq(payerProfiles.payerId, b.tpaId))
    const [sec] = await db().insert(patientPolicies).values({
      patientId: b.patientId, insurerPayerId: b.insurerId, policyNumber: 'POL-T2', memberId: 'MEM-T2', policyType: 'individual',
      holderName: 'Holder', relationship: 'self', validFrom: '2026-04-01', validTo: '2099-12-31', priority: 'secondary', createdByName: 'Test',
    }).returning()
    secondaryId = sec.id
    // Seven verifications over ten days; the newest (2 h ago) is current and carries limits.
    for (const h of [240, 200, 160, 120, 80, 40]) await verify(h)
    await check(5, 'pending') // older than the newest verification: not counted
    newestId = await verify(2, { source: 'nhcx_mock', context: 'checkin', method: null, balancePaise: 2_00_000_00, copayBp: null })
    await check(1.5, 'eligible')
    pendingNewId = await check(1, 'pending')
    await db().insert(patients).values({ id: barePatient, name: 'Test WS12 Bare', dob: '1990-01-01', gender: 'male' })
  })
  afterAll(async () => {
    await purgeCoverageFixtures([b.patientId])
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
    await db().delete(patients).where(eq(patients.id, barePatient))
  })

  it('returns the primary policy with its newest current verification, history ≤ 5 and the newer pending check', async () => {
    const s = await getCoverageSummary(b.patientId, 'view', NOW)
    expect(s.policies.map((p) => p.policyId)).toEqual([b.policyId, secondaryId])
    const p = s.primary!
    expect(p.policyId).toBe(b.policyId)
    expect(p.current?.id).toBe(newestId)
    expect(p.current).toMatchObject({ source: 'nhcx_mock', result: 'active', verifiedByName: 'Test Desk', method: null })
    expect(p.history).toHaveLength(5)
    expect(p.history[0].id).toBe(newestId)
    expect(p.history.map((h) => h.verifiedAt.getTime())).toEqual([...p.history.map((h) => h.verifiedAt.getTime())].sort((x, y) => y - x))
    expect(p.pendingCheckId).toBe(pendingNewId)
    expect(p.verdict).toMatchObject({ state: 'verified_active', severity: 'ok', label: 'Policy valid, verified 2 hours ago', isMock: true, policyId: b.policyId, verificationId: newestId })
    // Effective limits: verification values where given, else the policy's own.
    expect(p.limits).toEqual({ sumInsuredPaise: 5_00_000_00, balancePaise: 2_00_000_00, copayBp: 1000, roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00 })
  })

  it('a policy with nothing recorded is unverified', async () => {
    const s = await getCoverageSummary(b.patientId, 'ipd_admission', NOW)
    const sec = s.policies.find((p) => p.policyId === secondaryId)!
    expect(sec.current).toBeNull(); expect(sec.history).toEqual([]); expect(sec.pendingCheckId).toBeNull()
    expect(sec.verdict).toMatchObject({ state: 'unverified', severity: 'warn' })
  })

  it('once the newest verification expires, the pending check shows; with none, stale', async () => {
    const later = new Date(NOW.getTime() + 30 * H)
    const s = await getCoverageSummary(b.patientId, 'ipd_admission', later)
    expect(s.primary!.current).toBeNull()
    expect(s.primary!.verdict).toMatchObject({ state: 'pending', severity: 'warn' })
    expect(s.primary!.limits.balancePaise).toBeNull()
  })

  it('currentVerification: newest current row, but a newer error does not hide a current answer', async () => {
    expect((await currentVerification(db(), b.policyId, NOW))?.id).toBe(newestId)
    expect(await currentVerification(db(), b.policyId, new Date(NOW.getTime() + 30 * H))).toBeNull()
    expect(await currentVerification(db(), secondaryId, NOW)).toBeNull()
    const errorId = await verify(0.5, { source: 'nhcx', method: null, result: 'error' })
    expect((await currentVerification(db(), b.policyId, NOW))?.id).toBe(newestId)
    // Only an error is current once the answered rows expire.
    expect((await currentVerification(db(), b.policyId, new Date(NOW.getTime() + 22.25 * H)))?.id).toBe(errorId)
  })

  it('a patient with no policy has no primary', async () => {
    expect(await getCoverageSummary(barePatient, 'view', NOW)).toEqual({ primary: null, policies: [] })
  })
})
