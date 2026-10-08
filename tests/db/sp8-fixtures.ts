import { inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmConsents, abdmProfileShares, nhcxEligibilityChecks, nhcxExchanges, nhcxInboundCalls } from '@/db/schema'

/**
 * Removes every SP8 row of the given test patients, children first, in one transaction.
 * abdm_consents and nhcx_inbound_calls are append-only (SP8 migration triggers), so this runs
 * after the transaction-local `set_config('hims.allow_document_purge', 'on', true)`.
 * Test fixtures only. Run before SP7's purgeRcmFixtures (exchanges reference claims, pre-auths
 * and policies; eligibility checks reference policies and payers).
 */
export async function purgeSp8Fixtures(patientIds: string[]): Promise<void> {
  if (patientIds.length === 0) return
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    const exchangeIds = (await tx.select({ id: nhcxExchanges.id }).from(nhcxExchanges).where(inArray(nhcxExchanges.patientId, patientIds))).map((r) => r.id)
    if (exchangeIds.length > 0) {
      await tx.delete(nhcxInboundCalls).where(inArray(nhcxInboundCalls.exchangeId, exchangeIds))
      await tx.delete(nhcxExchanges).where(inArray(nhcxExchanges.id, exchangeIds))
    }
    await tx.delete(nhcxEligibilityChecks).where(inArray(nhcxEligibilityChecks.patientId, patientIds))
    await tx.delete(abdmProfileShares).where(inArray(abdmProfileShares.patientId, patientIds))
    await tx.delete(abdmConsents).where(inArray(abdmConsents.patientId, patientIds))
  })
}

/** Removes Scan & Share rows by request-id prefix (rows that never got a patient). */
export async function purgeSp8Shares(requestIdPrefix: string): Promise<void> {
  await getDb().delete(abdmProfileShares).where(sql`${abdmProfileShares.requestId} like ${`${requestIdPrefix}%`}`)
}

/** Removes consent rows by flow id (consents captured before registration have no patient). */
export async function purgeSp8Consents(flowIds: string[]): Promise<void> {
  if (flowIds.length === 0) return
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    await tx.delete(abdmConsents).where(inArray(abdmConsents.flowId, flowIds))
  })
}

/** Removes inbound-call rows by api_call_id (rows with no exchange). */
export async function purgeSp8InboundCalls(apiCallIds: string[]): Promise<void> {
  if (apiCallIds.length === 0) return
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    await tx.delete(nhcxInboundCalls).where(inArray(nhcxInboundCalls.apiCallId, apiCallIds))
  })
}
