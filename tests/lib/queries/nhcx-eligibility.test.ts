// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, billingSettings, nhcxEligibilityChecks, nhcxExchanges, patientPolicies, patients, payerProfiles, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { buildEligibilityOutbound, getEligibilityCheck, latestEligibilityForPolicy, requestEligibility } from '@/lib/queries/nhcx-eligibility'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const SESSION: Session = { role: 'frontdesk', name: `TEST-SP8-elig-${RUN}`, userId: null }
const NOW = new Date('2026-10-08T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('NHCX eligibility (DB)', () => {
  let b: RcmBase
  let providerId = 0
  let savedSettings: { hfrId: string | null; rohiniId: string | null } | null = null
  let savedReg: { council: 'nmc' | 'smc' | null; number: string | null } | null = null
  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'EL')
    await getDb().update(patients).set({ uhid: `UHT${RUN}EL`, abhaNumber: `91${RUN}00001`.slice(0, 14) }).where(eq(patients.id, b.patientId))
    await getDb().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}@sbx` }).where(eq(payerProfiles.payerId, b.tpaId))
    const [pr] = await getDb().select({ id: providers.id, council: providers.registrationCouncil, number: providers.registrationNumber }).from(providers).where(eq(providers.id, b.providerId))
    providerId = pr.id
    savedReg = { council: pr.council, number: pr.number }
    if (!pr.number) await getDb().update(providers).set({ registrationCouncil: 'nmc', registrationNumber: `T${RUN}` }).where(eq(providers.id, providerId))
    const [s] = await getDb().select({ hfrId: billingSettings.hfrId, rohiniId: billingSettings.rohiniId }).from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    await getDb().update(billingSettings).set({ hfrId: 'IN2710000123' }).where(eq(billingSettings.id, 1))
  })
  afterAll(async () => {
    if (savedReg) await getDb().update(providers).set({ registrationCouncil: savedReg.council, registrationNumber: savedReg.number }).where(eq(providers.id, providerId))
    if (savedSettings) await getDb().update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await getDb().delete(auditLog).where(eq(auditLog.userName, SESSION.name))
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })
  afterEach(() => vi.unstubAllEnvs())
  const mock = () => { vi.stubEnv('ABDM_USE_MOCKS', '1'); vi.stubEnv('NODE_ENV', 'development') }

  it('creates a pending check and an outbound exchange in one transaction, then schedules the send', async () => {
    mock()
    const scheduled: (() => Promise<unknown>)[] = []
    const dispatch = vi.fn(async () => 'sent')
    const r = await requestEligibility({ policyId: b.policyId, purpose: 'validation', context: 'manual', providerId }, SESSION, { now: () => NOW, schedule: (fn) => { scheduled.push(fn) }, dispatch })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [check] = await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, r.value.checkId))
    expect(check).toMatchObject({ status: 'pending', isMock: true, providerId, purpose: 'validation', context: 'manual', payerId: b.tpaId })
    const [ex] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, r.value.exchangeId))
    expect(ex).toMatchObject({ action: 'coverageeligibility/check', state: 'pending_send', eligibilityCheckId: check.id, recipientCode: `TPA${RUN}@sbx`, isMock: true })
    expect(dispatch).not.toHaveBeenCalled()
    await scheduled[0]()
    expect(dispatch).toHaveBeenCalledWith(ex.id)
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, SESSION.name), eq(auditLog.action, 'nhcx: requested eligibility')))
    expect(a.details).toBe(`check=${check.id} policy=${b.policyId} purpose=validation context=manual`)
    expect(await getEligibilityCheck(check.id)).toMatchObject({ id: check.id, status: 'pending', isMock: true })
    expect((await latestEligibilityForPolicy(b.policyId))!.id).toBe(check.id)
    const built = await buildEligibilityOutbound(ex, NOW)
    expect(built).toMatchObject({ ok: true, profile: 'CoverageEligibilityRequestBundle' })
  })

  it('the eligibility bundle carries ABHA only when the payer requires it', async () => {
    mock()
    const r = await requestEligibility({ policyId: b.policyId, purpose: 'benefits', context: 'manual', providerId }, SESSION, { now: () => NOW, schedule: () => {} })
    if (!r.ok) throw new Error(r.error)
    const [ex] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, r.value.exchangeId))
    const without = await buildEligibilityOutbound(ex, NOW)
    expect(without.ok && without.abhaId).toBeNull()
    await getDb().update(payerProfiles).set({ requiresAbha: true }).where(eq(payerProfiles.payerId, b.tpaId))
    const withAbha = await buildEligibilityOutbound(ex, NOW)
    expect(withAbha.ok && withAbha.abhaId).toMatch(/^\d{2}-\d{4}-\d{4}-\d{4}$/)
    await getDb().update(payerProfiles).set({ requiresAbha: false }).where(eq(payerProfiles.payerId, b.tpaId))
  })

  it('a payer without a participant code is refused with the copy and stores nothing', async () => {
    mock()
    await getDb().update(payerProfiles).set({ nhcxParticipantCode: null }).where(eq(payerProfiles.payerId, b.tpaId))
    const before = (await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.patientId, b.patientId))).length
    const r = await requestEligibility({ policyId: b.policyId, purpose: 'validation', context: 'manual', providerId }, SESSION, { now: () => NOW, schedule: () => {} })
    expect(r).toEqual({ ok: false, error: 'gateway_not_configured', message: 'This insurer or TPA has no NHCX participant code' })
    expect(await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.patientId, b.patientId))).toHaveLength(before)
    await getDb().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}@sbx` }).where(eq(payerProfiles.payerId, b.tpaId))
  })

  it('an expired policy is refused; without NHCX nothing is attempted', async () => {
    mock()
    const r = await requestEligibility({ policyId: b.policyId, purpose: 'validation', context: 'manual', providerId }, SESSION, { now: () => new Date('2100-06-01T00:00:00Z'), schedule: () => {} })
    expect(r).toMatchObject({ ok: false, error: 'payer_inactive' })
    vi.unstubAllEnvs()
    expect(await requestEligibility({ policyId: b.policyId, purpose: 'validation', context: 'manual', providerId }, SESSION)).toMatchObject({ ok: false, error: 'gateway_not_configured' })
    expect((await getDb().select().from(patientPolicies).where(eq(patientPolicies.id, b.policyId))).length).toBe(1)
  })
})
