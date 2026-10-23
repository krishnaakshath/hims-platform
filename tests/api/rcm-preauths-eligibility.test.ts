// @vitest-environment node
// WS12 T8 (R4, R5): POST /api/rcm/preauths against the database: the coverage gate, and the
// NHCX eligibility check started after the create commits (never failing it).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'

const NAME = `TEST-WS12-T8-${`${Date.now()}`.slice(-7)}`
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'rcm', name: NAME, userId: null })) }
})
// The NHCX send is scheduled with after(); nothing is sent from a test.
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, after: vi.fn() }
})

import { getDb } from '@/db/client'
import { auditLog, billingSettings, coverageVerifications, nhcxEligibilityChecks, patients, payerProfiles, preauths, providers } from '@/db/schema'
import { POST } from '@/app/api/rcm/preauths/route'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from '../lib/queries/preauth-world'
import { purgeSp8Fixtures } from '../db/sp8-fixtures'
import { purgeCoverageFixtures } from '../db/ws12-fixtures'

const RUN = NAME.slice(-7)
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/rcm/preauths', { method: 'POST', body: JSON.stringify(body) }))

describe.skipIf(!process.env.DATABASE_URL)('POST /api/rcm/preauths: coverage gate and auto eligibility (DB, WS12 T8)', () => {
  let w: PreauthWorld
  let savedSettings: { hfrId: string | null; rohiniId: string | null } | null = null
  let savedReg: { council: 'nmc' | 'smc' | null; number: string | null } | null = null
  const db = () => getDb()
  const body = (over: Record<string, unknown> = {}) => ({
    policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1,
    treatingProviderId: w.providerId, diagnosisCodeIds: [w.dxId], procedureCodeIds: [], estimate: [{ serviceId: w.pricedServiceId, quantity: 1 }], ...over,
  })
  const checksOf = () => db().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.patientId, w.patientId))

  beforeAll(async () => {
    process.env.INTEGRATION_PAYLOAD_KEY = process.env.INTEGRATION_PAYLOAD_KEY || randomBytes(32).toString('base64')
    w = await makePreauthWorld(RUN, 'E')
    await db().update(patients).set({ uhid: `UHT${RUN}E8` }).where(eq(patients.id, w.patientId))
    await db().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}E8@sbx` }).where(eq(payerProfiles.payerId, w.tpaId))
    const [pr] = await db().select({ council: providers.registrationCouncil, number: providers.registrationNumber }).from(providers).where(eq(providers.id, w.providerId))
    savedReg = { council: pr.council, number: pr.number }
    if (!pr.number) await db().update(providers).set({ registrationCouncil: 'nmc', registrationNumber: `T${RUN}` }).where(eq(providers.id, w.providerId))
    const [st] = await db().select({ hfrId: billingSettings.hfrId, rohiniId: billingSettings.rohiniId }).from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = st ?? null
    await db().update(billingSettings).set({ hfrId: 'IN2710000123' }).where(eq(billingSettings.id, 1))
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(async () => {
    if (savedReg) await db().update(providers).set({ registrationCouncil: savedReg.council, registrationNumber: savedReg.number }).where(eq(providers.id, w.providerId))
    if (savedSettings) await db().update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db().delete(auditLog).where(eq(auditLog.userName, NAME))
    await purgeCoverageFixtures([w.patientId])
    await purgeSp8Fixtures([w.patientId])
    await destroyPreauthWorld(w)
  })

  it('a planned date after the policy ends is 422 policy_not_in_force with the dates; nothing is written', async () => {
    const res = await post(body({ plannedAdmissionDate: '2100-02-01' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'This policy is not valid on 1 Feb 2100 (valid 1 Apr 2026–31 Dec 2099)' })
    expect(await db().select().from(preauths).where(eq(preauths.patientId, w.patientId))).toHaveLength(0)
  })

  it('NHCX not configured: the create succeeds and says no check started', async () => {
    vi.stubEnv('ABDM_USE_MOCKS', ''); vi.stubEnv('NHCX_API_BASE_URL', '')
    const res = await post(body())
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.preauthNumber).toMatch(/^PA-\d{4}-\d{6}$/)
    expect(json.eligibility).toEqual({ started: false, message: 'NHCX not configured: record a manual verification' })
    expect(await checksOf()).toHaveLength(0)
  })

  it('mock mode, payer on NHCX: one auth-requirements check in the preauth context for the treating doctor', async () => {
    vi.stubEnv('ABDM_USE_MOCKS', '1'); vi.stubEnv('NODE_ENV', 'development')
    const res = await post(body())
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.eligibility).toMatchObject({ started: true, checkId: expect.any(Number) })
    const checks = await checksOf()
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ id: json.eligibility.checkId, context: 'preauth', purpose: 'auth-requirements', providerId: w.providerId, policyId: w.policyId, isMock: true })
  })

  it('a current inactive verification is 409 coverage_inactive', async () => {
    const now = new Date()
    await db().insert(coverageVerifications).values({
      patientId: w.patientId, policyId: w.policyId, source: 'manual', result: 'inactive', context: 'manual', method: 'phone',
      verifiedByName: 'Test Desk', verifiedAt: new Date(now.getTime() - 60_000), validUntil: new Date(now.getTime() + 3_600_000),
    })
    const res = await post(body())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'The last verification says this policy is not in force' })
  })
})
