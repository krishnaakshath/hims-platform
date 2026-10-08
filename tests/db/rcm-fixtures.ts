import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  chargeLines, claimDisallowances, claimDispatches, claimDocuments, claimEvents, claimInvoices, claims, claimSettlements,
  claimSubmissions, claimWriteOffs, patientPolicies, payerContacts, payerDocumentRequirements, payerNetworks, payerProfiles,
  payers, preauthDocuments, encounters, patients, providers, preauthEvents, preauths, rcmQueries, rcmQueryResponses,
} from '@/db/schema'

/**
 * Removes every SP7 row of the given test patients and the given test payers, children first,
 * in one transaction. The append-only tables are guarded by migration C's triggers, so this
 * runs after the transaction-local `set_config('hims.allow_document_purge', 'on', true)`.
 * Test fixtures only. Run before SP4's purgeBillingFixtures (claim_invoices reference invoices).
 */
export async function purgeRcmFixtures(patientIds: string[], payerIds: number[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    if (patientIds.length > 0) {
      const claimIds = (await tx.select({ id: claims.id }).from(claims).where(inArray(claims.patientId, patientIds))).map((r) => r.id)
      const preauthIds = (await tx.select({ id: preauths.id }).from(preauths).where(inArray(preauths.patientId, patientIds))).map((r) => r.id)
      const queryIds = claimIds.length + preauthIds.length === 0 ? [] : (await tx.select({ id: rcmQueries.id }).from(rcmQueries).where(sql`${claimIds.length > 0 ? inArray(rcmQueries.claimId, claimIds) : sql`false`} OR ${preauthIds.length > 0 ? inArray(rcmQueries.preauthId, preauthIds) : sql`false`}`)).map((r) => r.id)
      const submissionIds = claimIds.length === 0 ? [] : (await tx.select({ id: claimSubmissions.id }).from(claimSubmissions).where(inArray(claimSubmissions.claimId, claimIds))).map((r) => r.id)
      if (claimIds.length > 0) {
        await tx.delete(claimWriteOffs).where(inArray(claimWriteOffs.claimId, claimIds))
        await tx.delete(claimSettlements).where(inArray(claimSettlements.claimId, claimIds))
        await tx.delete(claimDisallowances).where(inArray(claimDisallowances.claimId, claimIds))
        await tx.delete(claimDocuments).where(inArray(claimDocuments.claimId, claimIds))
      }
      if (preauthIds.length > 0) await tx.delete(preauthDocuments).where(inArray(preauthDocuments.preauthId, preauthIds))
      if (queryIds.length > 0) {
        await tx.delete(rcmQueryResponses).where(inArray(rcmQueryResponses.queryId, queryIds))
        await tx.delete(rcmQueries).where(inArray(rcmQueries.id, queryIds))
      }
      if (claimIds.length > 0) await tx.delete(claimEvents).where(inArray(claimEvents.claimId, claimIds))
      if (submissionIds.length > 0) {
        await tx.delete(claimDispatches).where(inArray(claimDispatches.submissionId, submissionIds))
        await tx.delete(claimSubmissions).where(inArray(claimSubmissions.id, submissionIds))
      }
      if (claimIds.length > 0) await tx.delete(claimInvoices).where(inArray(claimInvoices.claimId, claimIds))
      if (preauthIds.length > 0) await tx.update(chargeLines).set({ preauthId: null }).where(inArray(chargeLines.preauthId, preauthIds))
      if (claimIds.length > 0) await tx.delete(claims).where(inArray(claims.id, claimIds))
      if (preauthIds.length > 0) {
        await tx.delete(preauthEvents).where(inArray(preauthEvents.preauthId, preauthIds))
        await tx.delete(preauths).where(inArray(preauths.id, preauthIds))
      }
      await tx.delete(patientPolicies).where(inArray(patientPolicies.patientId, patientIds))
    }
    if (payerIds.length > 0) {
      await tx.delete(payerDocumentRequirements).where(inArray(payerDocumentRequirements.payerId, payerIds))
      await tx.delete(payerContacts).where(inArray(payerContacts.payerId, payerIds))
      await tx.delete(payerNetworks).where(sql`${inArray(payerNetworks.insurerPayerId, payerIds)} OR ${inArray(payerNetworks.tpaPayerId, payerIds)}`)
      await tx.delete(payerProfiles).where(inArray(payerProfiles.payerId, payerIds))
      await tx.delete(payers).where(inArray(payers.id, payerIds))
    }
  })
}


export interface RcmBase { patientId: string; insurerId: number; tpaId: number; policyId: number; encounterId: number; providerId: number }

/**
 * A minimal SP7 world for one test patient: an insurer and a TPA with profiles (payer codes
 * `TSP7<run><suffix>`), an active primary policy and a completed OPD encounter with an
 * existing provider. Clean up with purgeRcmFixtures([patientId], [insurerId, tpaId]) and
 * deleteRcmBasePatient(patientId).
 */
export async function makeRcmBase(run: string, suffix: string): Promise<RcmBase> {
  const db = getDb()
  const patientId = `TEST-SP7-${run}-${suffix}`
  await db.insert(patients).values({ id: patientId, name: `Test SP7 ${suffix}`, dob: '1990-01-01', gender: 'female' })
  const [ins] = await db.insert(payers).values({ name: `Test SP7 Insurer ${run}${suffix}`, payerId: `TSP7${run}${suffix}I`, payerType: 'other' }).returning()
  const [tpa] = await db.insert(payers).values({ name: `Test SP7 TPA ${run}${suffix}`, payerId: `TSP7${run}${suffix}T`, payerType: 'other' }).returning()
  await db.insert(payerProfiles).values([
    { payerId: ins.id, kind: 'insurer', empanelmentStatus: 'empanelled', updatedByName: 'Test' },
    { payerId: tpa.id, kind: 'tpa', empanelmentStatus: 'empanelled', updatedByName: 'Test' },
  ])
  const [policy] = await db.insert(patientPolicies).values({
    patientId, insurerPayerId: ins.id, tpaPayerId: tpa.id, policyNumber: 'POL-T1', memberId: 'MEM-T1', policyType: 'individual',
    holderName: 'Holder', relationship: 'self', validFrom: '2026-04-01', validTo: '2099-12-31', createdByName: 'Test',
  }).returning()
  const [provider] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [enc] = await db.insert(encounters).values({
    patientId, encounterType: 'opd', encounterDate: '2026-10-01', providerId: provider.id, checkedInByName: 'Test', status: 'completed', completedAt: new Date('2026-10-01T06:00:00Z'),
  }).returning()
  return { patientId, insurerId: ins.id, tpaId: tpa.id, policyId: policy.id, encounterId: enc.id, providerId: provider.id }
}

/** Deletes the base encounter and patient (after purgeRcmFixtures / purgeBillingFixtures). */
export async function deleteRcmBasePatient(patientId: string): Promise<void> {
  const db = getDb()
  await db.delete(encounters).where(eq(encounters.patientId, patientId))
  await db.delete(patients).where(eq(patients.id, patientId))
}
