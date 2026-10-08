import { describe, it, expect, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { claims, claimEvents, claimSubmissions, patientPolicies, patients, preauths, preauthEvents } from '@/db/schema'
import { deletePatient, PatientHasFinancialRecordsError } from '@/lib/queries/patients'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'

const RUN = `${Date.now()}`.slice(-7)

describe.skipIf(!process.env.DATABASE_URL)('deletePatient and SP7 retention (ruling 11)', () => {
  const made: RcmBase[] = []
  afterAll(async () => {
    for (const b of made) {
      await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
      await deleteRcmBasePatient(b.patientId)
    }
  })
  const claimRow = (b: RcmBase, n: string, status: 'draft' | 'submitted' | 'withdrawn') => ({
    claimNumber: `CLM-2099-D${RUN}${n}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId,
    billingPayerId: b.tpaId, claimType: 'opd' as const, encounterId: b.encounterId, createdByName: 'T', status,
  })
  const preauthRow = (b: RcmBase, n: string, status: 'draft' | 'cancelled' | 'requested') => ({
    preauthNumber: `PA-2099-D${RUN}${n}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId,
    claimType: 'opd' as const, encounterId: b.encounterId, status, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1,
    treatingProviderId: b.providerId, estimateLines: [], estimatedPaise: 0, requestedPaise: 0, createdByName: 'T',
  })

  it('refuses to delete a patient with a submitted claim and deletes one with only a draft claim and a policy', async () => {
    const kept = await makeRcmBase(RUN, 'K'); made.push(kept)
    await getDb().insert(claims).values(claimRow(kept, 'K', 'submitted'))
    await expect(deletePatient(kept.patientId)).rejects.toBeInstanceOf(PatientHasFinancialRecordsError)
    expect(await getDb().select().from(patients).where(eq(patients.id, kept.patientId))).toHaveLength(1)

    const gone = await makeRcmBase(RUN, 'G')
    const [c] = await getDb().insert(claims).values(claimRow(gone, 'G', 'draft')).returning()
    const [w] = await getDb().insert(claims).values(claimRow(gone, 'W', 'withdrawn')).returning()
    await getDb().insert(claimEvents).values({ claimId: w.id, action: 'withdraw', fromStatus: 'draft', toStatus: 'withdrawn', byName: 'T' })
    const [p] = await getDb().insert(preauths).values(preauthRow(gone, 'G', 'cancelled')).returning()
    await getDb().insert(preauthEvents).values({ preauthId: p.id, action: 'cancel', fromStatus: 'draft', toStatus: 'cancelled', byName: 'T' })
    expect(await deletePatient(gone.patientId)).toBe(true)
    expect(await getDb().select().from(claims).where(eq(claims.id, c.id))).toEqual([])
    expect(await getDb().select().from(preauths).where(eq(preauths.id, p.id))).toEqual([])
    expect(await getDb().select().from(patientPolicies).where(eq(patientPolicies.patientId, gone.patientId))).toEqual([])
    expect(await getDb().select().from(patients).where(eq(patients.id, gone.patientId))).toEqual([])
    made.push({ ...gone, patientId: `${gone.patientId}-gone` })
  })

  it('a requested pre-auth or any submission keeps the patient', async () => {
    const a = await makeRcmBase(RUN, 'A'); made.push(a)
    await getDb().insert(preauths).values(preauthRow(a, 'A', 'requested'))
    await expect(deletePatient(a.patientId)).rejects.toBeInstanceOf(PatientHasFinancialRecordsError)
    const s = await makeRcmBase(RUN, 'S'); made.push(s)
    const [c] = await getDb().insert(claims).values(claimRow(s, 'S', 'withdrawn')).returning()
    await getDb().insert(claimSubmissions).values({ claimId: c.id, version: 1, kind: 'initial', snapshot: {} as never, snapshotSha256: 'a', rcmCopyBlobUrl: 'u', rcmCopySha256: 'b', insurerCopyBlobUrl: 'u', insurerCopySha256: 'c', createdByName: 'T' })
    await expect(deletePatient(s.patientId)).rejects.toBeInstanceOf(PatientHasFinancialRecordsError)
  })
})
