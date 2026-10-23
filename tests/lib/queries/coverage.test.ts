import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, billingSettings, coverageVerifications, encounters, nhcxEligibilityChecks, patientPolicies, patients, payerProfiles, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { getCoverageSummary, currentVerification, defaultEligibilityProviderId, maybeStartEligibility } from '@/lib/queries/coverage'
import { createPolicy } from '@/lib/queries/rcm-policies'
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

describe.skipIf(!process.env.DATABASE_URL)('policy add: validity and the auto eligibility check (DB, WS12 T4)', () => {
  const SESSION: Session = { role: 'frontdesk', name: `TEST-WS12-T4-${RUN}`, userId: null }
  const AT = new Date('2026-10-23T06:30:00Z')
  const noSend = { schedule: () => {} }
  let b: RcmBase
  const bare = `TEST-WS12-${RUN}-NOENC`
  let savedSettings: { hfrId: string | null; rohiniId: string | null } | null = null
  let savedReg: { council: 'nmc' | 'smc' | null; number: string | null } | null = null
  const db = () => getDb()
  const checksOf = (patientId: string) => db().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.patientId, patientId))
  const mock = () => { vi.stubEnv('ABDM_USE_MOCKS', '1'); vi.stubEnv('NODE_ENV', 'development') }

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12A')
    await db().update(patients).set({ uhid: `UHT${RUN}WA` }).where(eq(patients.id, b.patientId))
    await db().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}@sbx` }).where(eq(payerProfiles.payerId, b.tpaId))
    const [pr] = await db().select({ council: providers.registrationCouncil, number: providers.registrationNumber }).from(providers).where(eq(providers.id, b.providerId))
    savedReg = { council: pr.council, number: pr.number }
    if (!pr.number) await db().update(providers).set({ registrationCouncil: 'nmc', registrationNumber: `T${RUN}` }).where(eq(providers.id, b.providerId))
    const [st] = await db().select({ hfrId: billingSettings.hfrId, rohiniId: billingSettings.rohiniId }).from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = st ?? null
    await db().update(billingSettings).set({ hfrId: 'IN2710000123' }).where(eq(billingSettings.id, 1))
    await db().insert(patients).values({ id: bare, name: 'Test WS12 No Encounter', dob: '1990-01-01', gender: 'male' })
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(async () => {
    if (savedReg) await db().update(providers).set({ registrationCouncil: savedReg.council, registrationNumber: savedReg.number }).where(eq(providers.id, b.providerId))
    if (savedSettings) await db().update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db().delete(auditLog).where(eq(auditLog.userName, SESSION.name))
    await purgeCoverageFixtures([b.patientId, bare])
    await purgeSp8Fixtures([b.patientId, bare])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await db().delete(patientPolicies).where(eq(patientPolicies.patientId, bare))
    await deleteRcmBasePatient(b.patientId)
    await db().delete(patients).where(eq(patients.id, bare))
  })

  it('createPolicy refuses an already-expired active policy with the dates; an inactive one is still recorded', async () => {
    const input = {
      patientId: b.patientId, insurerPayerId: b.insurerId, tpaPayerId: null, policyNumber: 'POL-OLD', memberId: 'MEM-OLD', policyType: 'individual' as const,
      holderName: 'Holder', relationship: 'self' as const, validFrom: '2025-04-01', validTo: '2026-10-22', priority: 'secondary' as const, status: 'active' as const,
    }
    const r = await createPolicy(input, SESSION, AT)
    expect(r).toEqual({ ok: false, error: 'policy_not_in_force', message: 'This policy is not valid on 23 Oct 2026 (valid 1 Apr 2025–22 Oct 2026)' })
    expect(await db().select().from(patientPolicies).where(and(eq(patientPolicies.patientId, b.patientId), eq(patientPolicies.policyNumber, 'POL-OLD')))).toHaveLength(0)
    const inactive = await createPolicy({ ...input, status: 'inactive' }, SESSION, AT)
    expect(inactive.ok).toBe(true)
  })

  it('defaultEligibilityProviderId: the latest non-cancelled encounter doctor, or null', async () => {
    expect(await defaultEligibilityProviderId(b.patientId)).toBe(b.providerId)
    expect(await defaultEligibilityProviderId(bare)).toBeNull()
    const [other] = (await db().select({ id: providers.id }).from(providers).limit(5)).filter((r) => r.id !== b.providerId)
    if (other) {
      const [enc] = await db().insert(encounters).values({ patientId: b.patientId, encounterType: 'opd', encounterDate: '2026-10-20', providerId: other.id, checkedInByName: 'Test', status: 'cancelled' }).returning()
      expect(await defaultEligibilityProviderId(b.patientId)).toBe(b.providerId)
      await db().delete(encounters).where(eq(encounters.id, enc.id))
    }
  })

  it('NHCX not configured: says so and starts nothing', async () => {
    vi.stubEnv('ABDM_USE_MOCKS', ''); vi.stubEnv('NHCX_API_BASE_URL', '')
    const before = (await checksOf(b.patientId)).length
    const r = await maybeStartEligibility({ policyId: b.policyId, context: 'registration', providerId: b.providerId }, SESSION, AT, noSend)
    expect(r).toEqual({ started: false, reason: 'nhcx_not_configured', message: 'NHCX not configured: record a manual verification' })
    expect(await checksOf(b.patientId)).toHaveLength(before)
  })

  it('no doctor known: no_doctor, nothing started', async () => {
    mock()
    const r = await maybeStartEligibility({ policyId: b.policyId, context: 'registration', providerId: null }, SESSION, AT, noSend)
    expect(r).toMatchObject({ started: false, reason: 'no_doctor' })
  })

  it('an insurer not on NHCX: not_on_nhcx', async () => {
    mock()
    await db().update(payerProfiles).set({ nhcxParticipantCode: null }).where(eq(payerProfiles.payerId, b.tpaId))
    const r = await maybeStartEligibility({ policyId: b.policyId, context: 'registration', providerId: b.providerId }, SESSION, AT, noSend)
    await db().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}@sbx` }).where(eq(payerProfiles.payerId, b.tpaId))
    expect(r).toMatchObject({ started: false, reason: 'not_on_nhcx' })
  })

  it('hospital IDs missing: not_ready with the requestEligibility message', async () => {
    mock()
    await db().update(billingSettings).set({ hfrId: null, rohiniId: null }).where(eq(billingSettings.id, 1))
    const r = await maybeStartEligibility({ policyId: b.policyId, context: 'registration', providerId: b.providerId }, SESSION, AT, noSend)
    await db().update(billingSettings).set({ hfrId: 'IN2710000123' }).where(eq(billingSettings.id, 1))
    expect(r).toMatchObject({ started: false, reason: 'not_ready' })
    if (!r.started) expect(r.message).toMatch(/ROHINI|HFR/)
  })

  it('in mock mode with a doctor: starts one registration check; with a current active verification: already_verified', async () => {
    mock()
    const before = (await checksOf(b.patientId)).length
    const r = await maybeStartEligibility({ policyId: b.policyId, context: 'registration', providerId: b.providerId }, SESSION, AT, noSend)
    expect(r).toMatchObject({ started: true })
    const rows = await checksOf(b.patientId)
    expect(rows).toHaveLength(before + 1)
    const row = rows.find((c) => r.started && c.id === r.checkId)!
    expect(row).toMatchObject({ context: 'registration', purpose: 'validation', isMock: true, policyId: b.policyId, providerId: b.providerId, status: 'pending' })

    await db().insert(coverageVerifications).values({
      patientId: b.patientId, policyId: b.policyId, source: 'manual', result: 'active', context: 'manual', method: 'phone',
      verifiedByName: 'Test Desk', verifiedAt: new Date(AT.getTime() - 3_600_000), validUntil: new Date(AT.getTime() + 3_600_000),
    })
    const again = await maybeStartEligibility({ policyId: b.policyId, context: 'registration', providerId: b.providerId }, SESSION, AT, noSend)
    expect(again).toMatchObject({ started: false, reason: 'already_verified' })
    expect(await checksOf(b.patientId)).toHaveLength(before + 1)
  })
})
