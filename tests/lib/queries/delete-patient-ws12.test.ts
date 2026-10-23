import { describe, it, expect, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, coverageVerifications, nhcxEligibilityChecks, patients } from '@/db/schema'
import { deletePatient } from '@/lib/queries/patients'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'
import { purgeCoverageFixtures } from '../../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)

describe.skipIf(!process.env.DATABASE_URL)('deletePatient and WS12 coverage rows', () => {
  let b: RcmBase | null = null
  afterAll(async () => {
    if (!b) return
    await purgeCoverageFixtures([b.patientId], { dropAdmissions: true })
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('deletes append-only verifications and admission coverage with the patient', async () => {
    b = await makeRcmBase(RUN, 'D12')
    const [check] = await getDb().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'checkin', requestedByName: 'T' }).returning()
    const at = new Date()
    const [v] = await getDb().insert(coverageVerifications).values({
      patientId: b.patientId, policyId: b.policyId, source: 'nhcx_mock', result: 'active', context: 'checkin', nhcxCheckId: check.id,
      verifiedByName: 'T', verifiedAt: at, validUntil: new Date(at.getTime() + 86_400_000),
    }).returning()
    const [a] = await getDb().insert(admissions).values({ patientId: b.patientId, attendingProviderId: b.providerId, status: 'discharged', dischargedAt: at }).returning()
    await getDb().insert(admissionCoverage).values({ admissionId: a.id, mode: 'cashless', policyId: b.policyId, coverageState: 'verified_active', verificationId: v.id, recordedByName: 'T' })

    expect(await deletePatient(b.patientId)).toBe(true)
    expect(await getDb().select().from(patients).where(eq(patients.id, b.patientId))).toEqual([])
    expect(await getDb().select().from(coverageVerifications).where(eq(coverageVerifications.id, v.id))).toEqual([])
    expect(await getDb().select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, a.id))).toEqual([])
  })
})
