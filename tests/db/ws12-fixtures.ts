import { inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, coverageVerifications } from '@/db/schema'

/**
 * Removes every WS12 coverage row of the given test patients (admission coverage, then
 * verifications), and with `dropAdmissions` the patients' admissions too. coverage_verifications
 * is append-only (WS12 trigger), so this runs after the transaction-local
 * `set_config('hims.allow_document_purge', 'on', true)`. Test fixtures only. Run before SP8's
 * purgeSp8Fixtures (verifications reference eligibility checks) and SP7's purgeRcmFixtures.
 */
export async function purgeCoverageFixtures(patientIds: string[], opts: { dropAdmissions?: boolean } = {}): Promise<void> {
  if (patientIds.length === 0) return
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    const admissionIds = (await tx.select({ id: admissions.id }).from(admissions).where(inArray(admissions.patientId, patientIds))).map((r) => r.id)
    if (admissionIds.length > 0) await tx.delete(admissionCoverage).where(inArray(admissionCoverage.admissionId, admissionIds))
    await tx.delete(coverageVerifications).where(inArray(coverageVerifications.patientId, patientIds))
    if (opts.dropAdmissions && admissionIds.length > 0) await tx.delete(admissions).where(inArray(admissions.id, admissionIds))
  })
}
