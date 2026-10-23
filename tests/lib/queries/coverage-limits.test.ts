import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, chargeLines, coverageVerifications, patientPolicies, serviceCatalog } from '@/db/schema'
import { coverageLimitsForCharge } from '@/lib/queries/coverage-limits'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeBillingFixtures } from '../../db/billing-fixtures'
import { purgeCoverageFixtures } from '../../db/ws12-fixtures'

// WS12 T10 (spec R7, R8): the limits and running insured total a payer charge line is checked against.
const RUN = `${Date.now()}`.slice(-7)
const NOW = new Date('2026-10-23T06:30:00Z')
const H = 3_600_000

describe.skipIf(!process.env.DATABASE_URL)('coverageLimitsForCharge (DB)', () => {
  let b: RcmBase
  let admissionId = 0
  let otherAdmissionId = 0
  let cashlessAdmissionId = 0
  let secondaryPolicyId = 0
  let serviceId = 0
  const db = () => getDb()
  const line = async (adm: number, payerId: number | null, taxablePaise: number, status: 'captured' | 'void' = 'captured') => {
    await db().insert(chargeLines).values({
      patientId: b.patientId, admissionId: adm, source: 'manual', status, serviceId, itemCode: 'T10', itemName: 'Test T10',
      serviceDate: '2026-10-22', quantity: 1, unitPricePaise: taxablePaise, priceSource: 'base', taxablePaise, gstRateBp: 0, hsnSac: '999312',
      payerId, createdByName: 'Test', ...(status === 'void' ? { voidReason: 'test void', voidedAt: NOW, voidedByName: 'Test' } : {}),
    })
  }
  const verify = async (policyId: number, hoursAgo: number, validForHours: number, over: Partial<typeof coverageVerifications.$inferInsert> = {}) => {
    const verifiedAt = new Date(NOW.getTime() - hoursAgo * H)
    await db().insert(coverageVerifications).values({
      patientId: b.patientId, policyId, source: 'nhcx_mock', result: 'active', context: 'admission',
      verifiedByName: 'Test Desk', verifiedAt, validUntil: new Date(verifiedAt.getTime() + validForHours * H), ...over,
    })
  }

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12L')
    await db().update(patientPolicies).set({ sumInsuredPaise: 5_00_000_00, roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00 }).where(eq(patientPolicies.id, b.policyId))
    // A secondary policy billed to the insurer directly (no TPA), with its own limits.
    const [sec] = await db().insert(patientPolicies).values({
      patientId: b.patientId, insurerPayerId: b.insurerId, policyNumber: 'POL-T10', memberId: 'MEM-T10', policyType: 'individual',
      holderName: 'Holder', relationship: 'self', validFrom: '2026-04-01', validTo: '2099-12-31', priority: 'secondary',
      sumInsuredPaise: 1_00_000_00, roomRentLimitPaise: 2_000_00, createdByName: 'Test',
    }).returning()
    secondaryPolicyId = sec.id
    const [svc] = await db().select({ id: serviceCatalog.id }).from(serviceCatalog).limit(1)
    serviceId = svc.id
    // WS3 T1: one active stay per patient, so the first two stays are discharged ones.
    const admit = async (discharged = false) => (await db().insert(admissions).values({
      patientId: b.patientId, attendingProviderId: b.providerId, admittedAt: new Date('2026-10-20T06:00:00Z'),
      ...(discharged ? { status: 'discharged' as const, dischargedAt: new Date('2026-10-21T06:00:00Z') } : {}),
    }).returning())[0].id
    admissionId = await admit(true)
    otherAdmissionId = await admit(true)
    cashlessAdmissionId = await admit()
    await line(admissionId, b.tpaId, 1_00_000_00)
    await line(admissionId, b.tpaId, 40_000_00)
    await line(admissionId, b.tpaId, 50_000_00, 'void')     // void: not counted
    await line(admissionId, null, 20_000_00)                 // self-pay: not counted
    await line(admissionId, b.insurerId, 7_000_00)           // another payer: not counted
    await line(otherAdmissionId, b.tpaId, 10_000_00)         // another admission: not counted
    await line(cashlessAdmissionId, b.insurerId, 25_000_00)
    await db().insert(admissionCoverage).values({
      admissionId: cashlessAdmissionId, mode: 'cashless', policyId: secondaryPolicyId, coverageState: 'unverified', recordedByName: 'Test',
    })
  })
  afterAll(async () => {
    await purgeBillingFixtures([b.patientId])
    await purgeCoverageFixtures([b.patientId], { dropAdmissions: true })
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('without a verification: the active primary policy whose billing payer is the line payer, and its sum insured as the balance', async () => {
    expect(await coverageLimitsForCharge(db(), { patientId: b.patientId, admissionId, payerId: b.tpaId, now: NOW })).toEqual({
      roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00, balancePaise: 5_00_000_00, insuredRunningPaise: 1_40_000_00,
    })
  })

  it('a current mock verification’s balance and limits win over the policy; an expired one is ignored', async () => {
    await verify(b.policyId, 72, 24, { balancePaise: 10_000_00, roomRentLimitPaise: 1_000_00 }) // expired
    await verify(b.policyId, 2, 24, { balancePaise: 2_00_000_00, roomRentLimitPaise: 4_000_00 })
    expect(await coverageLimitsForCharge(db(), { patientId: b.patientId, admissionId, payerId: b.tpaId, now: NOW })).toEqual({
      roomRentLimitPaise: 4_000_00, icuLimitPaise: 6_000_00, balancePaise: 2_00_000_00, insuredRunningPaise: 1_40_000_00,
    })
  })

  it('outside an admission the running total is zero', async () => {
    expect(await coverageLimitsForCharge(db(), { patientId: b.patientId, admissionId: null, payerId: b.tpaId, now: NOW }))
      .toMatchObject({ balancePaise: 2_00_000_00, insuredRunningPaise: 0 })
  })

  it('a cashless admission uses the admission_coverage policy', async () => {
    expect(await coverageLimitsForCharge(db(), { patientId: b.patientId, admissionId: cashlessAdmissionId, payerId: b.insurerId, now: NOW })).toEqual({
      roomRentLimitPaise: 2_000_00, icuLimitPaise: null, balancePaise: 1_00_000_00, insuredRunningPaise: 25_000_00,
    })
  })

  it('no policy for the payer: null', async () => {
    // The insurer is not the billing payer of the primary policy, and this admission has no cashless row.
    expect(await coverageLimitsForCharge(db(), { patientId: b.patientId, admissionId, payerId: b.insurerId, now: NOW })).toBeNull()
  })
})
