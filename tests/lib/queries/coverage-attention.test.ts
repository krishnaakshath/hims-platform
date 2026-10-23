import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, billingSettings, claims, coverageVerifications, patientPolicies, patients } from '@/db/schema'
import { getInsuranceAttention, listExpiringPolicies } from '@/lib/queries/coverage-attention'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeCoverageFixtures } from '../../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const NOW = new Date('2026-10-23T06:30:00Z') // 12:00 IST on 2026-10-23

describe.skipIf(!process.env.DATABASE_URL)('insurance attention (DB)', () => {
  let b: RcmBase
  let p3 = 0
  let p9 = 0
  let admissionId = 0
  let priorIdentifiers: { rohiniId: string | null; hfrId: string | null } | null = null
  const db = () => getDb()
  const mine = <T extends { patientId: string }>(rows: T[]) => rows.filter((r) => r.patientId === b.patientId)

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12A')
    await db().update(patients).set({ uhid: `UHW12A${RUN}` }).where(eq(patients.id, b.patientId))
    // base policy (valid to 2099) is the "not expiring" control; add one ending in 3 days and one in 9
    const mk = (validTo: string, n: string) => db().insert(patientPolicies).values({
      patientId: b.patientId, insurerPayerId: b.insurerId, policyNumber: `POL-${n}`, memberId: `M-${n}`, policyType: 'individual',
      holderName: 'Holder', relationship: 'self', validFrom: '2026-01-01', validTo, priority: 'secondary', createdByName: 'Test',
    }).returning()
    p3 = (await mk('2026-10-26', '3'))[0].id
    p9 = (await mk('2026-11-01', '9'))[0].id
    const [adm] = await db().insert(admissions).values({ patientId: b.patientId, attendingProviderId: b.providerId, admittedAt: new Date('2026-10-23T03:00:00Z') }).returning()
    admissionId = adm.id
    await db().insert(admissionCoverage).values({ admissionId, mode: 'cashless', policyId: b.policyId, coverageState: 'unverified', recordedByName: 'Test' })
    const [bs] = await db().select({ rohiniId: billingSettings.rohiniId, hfrId: billingSettings.hfrId }).from(billingSettings).where(eq(billingSettings.id, 1)).limit(1)
    priorIdentifiers = bs ?? null
  })
  afterAll(async () => {
    if (priorIdentifiers) await db().update(billingSettings).set(priorIdentifiers).where(eq(billingSettings.id, 1))
    await db().delete(claims).where(eq(claims.patientId, b.patientId))
    await purgeCoverageFixtures([b.patientId], { dropAdmissions: true })
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('counts a policy ending in 3 days but not one ending in 9', async () => {
    const list = await listExpiringPolicies(NOW)
    const ids = mine(list).map((r) => r.policyId)
    expect(ids).toContain(p3)
    expect(ids).not.toContain(p9)
    expect(ids).not.toContain(b.policyId)
    const row = list.find((r) => r.policyId === p3)!
    expect(row.uhid).toBe(`UHW12A${RUN}`)
    expect(row.validTo).toBe('2026-10-26')
    expect((await getInsuranceAttention(NOW)).policiesExpiringIn7Days).toBeGreaterThanOrEqual(1)
  })

  it('lists a cashless admission admitted today without a verification, by UHID, and drops it once verified', async () => {
    const before = (await getInsuranceAttention(NOW)).admissionsTodayUnverified.filter((a) => a.admissionId === admissionId)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ patientId: b.patientId, uhid: `UHW12A${RUN}` })
    expect(before[0].payerName).toContain('Insurer')
    await db().insert(coverageVerifications).values({
      patientId: b.patientId, policyId: b.policyId, source: 'manual', result: 'active', context: 'manual', method: 'phone',
      verifiedByName: 'Test Desk', verifiedAt: NOW, validUntil: new Date(NOW.getTime() + 24 * 3_600_000),
    })
    const after = (await getInsuranceAttention(NOW)).admissionsTodayUnverified.filter((a) => a.admissionId === admissionId)
    expect(after).toHaveLength(0)
  })

  it('ignores an admission admitted yesterday (IST)', async () => {
    const [old] = await db().insert(admissions).values({ patientId: b.patientId, attendingProviderId: b.providerId, admittedAt: new Date('2026-10-22T10:00:00Z') }).returning()
    await db().insert(admissionCoverage).values({ admissionId: old.id, mode: 'cashless', policyId: p3, coverageState: 'unverified', recordedByName: 'Test' })
    const rows = (await getInsuranceAttention(NOW)).admissionsTodayUnverified
    expect(rows.find((a) => a.admissionId === old.id)).toBeUndefined()
  })

  it('counts draft claims as blocked only while both identifiers are missing', async () => {
    await db().insert(claims).values({
      claimNumber: `TEST-W12A-${RUN}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, billingPayerId: b.insurerId,
      claimType: 'opd', encounterId: b.encounterId, status: 'draft', createdByName: 'Test',
    })
    await db().insert(billingSettings).values({ id: 1, rohiniId: null, hfrId: null }).onConflictDoUpdate({ target: billingSettings.id, set: { rohiniId: null, hfrId: null } })
    expect((await getInsuranceAttention(NOW)).claimsBlockedByIdentifiers).toBeGreaterThanOrEqual(1)
    await db().update(billingSettings).set({ rohiniId: '1234567890123' }).where(eq(billingSettings.id, 1))
    expect((await getInsuranceAttention(NOW)).claimsBlockedByIdentifiers).toBe(0)
  })
})
