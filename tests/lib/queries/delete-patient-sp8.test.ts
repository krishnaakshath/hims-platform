import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmConsents, abdmProfileShares, nhcxEligibilityChecks, nhcxExchanges, patients } from '@/db/schema'
import { deletePatient, PatientHasFinancialRecordsError } from '@/lib/queries/patients'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'

const RUN = `${Date.now()}`.slice(-7)

describe.skipIf(!process.env.DATABASE_URL)('deletePatient and SP8 rows', () => {
  const made: RcmBase[] = []
  afterAll(async () => {
    for (const b of made) {
      await purgeSp8Fixtures([b.patientId])
      await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
      await deleteRcmBasePatient(b.patientId)
    }
  })

  it('deletes the consents, linked shares and eligibility checks with the patient', async () => {
    const b = await makeRcmBase(RUN, 'D8')
    const [consent] = await getDb().insert(abdmConsents).values({
      patientId: b.patientId, flowId: randomUUID(), purpose: 'abha_verification', consentCode: 'abha-enrollment', consentVersion: '1.4', textSha256: 'f'.repeat(64), givenBy: 'patient', recordedByName: 'T',
    }).returning()
    const [share] = await getDb().insert(abdmProfileShares).values({
      requestId: `TEST-SP8-${RUN}-D8`, hipId: 'HFR1', counterId: 'C1', intent: 'REGISTRATION', tokenDate: '2099-01-02', tokenNumber: 1, status: 'linked', patientId: b.patientId,
    }).returning()
    const [check] = await getDb().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'manual', requestedByName: 'T' }).returning()

    expect(await deletePatient(b.patientId)).toBe(true)
    expect(await getDb().select().from(patients).where(eq(patients.id, b.patientId))).toEqual([])
    expect(await getDb().select().from(abdmConsents).where(eq(abdmConsents.id, consent.id))).toEqual([])
    expect(await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, share.id))).toEqual([])
    expect(await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, check.id))).toEqual([])
    made.push({ ...b, patientId: `${b.patientId}-gone` })
  })

  it('a patient with an NHCX exchange is kept', async () => {
    const b = await makeRcmBase(RUN, 'X8'); made.push(b)
    await getDb().insert(nhcxExchanges).values({
      entityType: 'coverageeligibility', direction: 'outbound', action: 'coverageeligibility/check', correlationId: randomUUID(), apiCallId: randomUUID(),
      senderCode: 'P1@sbx', recipientCode: 'INS1@sbx', state: 'sent', patientId: b.patientId, policyId: b.policyId, bodySha256: 'a'.repeat(64),
    })
    await expect(deletePatient(b.patientId)).rejects.toBeInstanceOf(PatientHasFinancialRecordsError)
    expect(await getDb().select().from(patients).where(eq(patients.id, b.patientId))).toHaveLength(1)
  })
})
