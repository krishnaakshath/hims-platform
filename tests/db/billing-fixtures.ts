import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { chargeLines, creditNotes, documentCounters, invoiceLines, invoices, patientPayments, refunds } from '@/db/schema'

/** The test-only financial year: finalising tests pass now = 2099-06-01, which numbers in 2099-00. */
export const TEST_FINANCIAL_YEAR = '2099-00'

/**
 * Removes every SP4 billing row of the given test patients, children first, plus the
 * 2099-00 document counters. Issued documents are protected by the migration-B triggers,
 * so this runs in one transaction after the transaction-local
 * `set_config('hims.allow_document_purge', 'on', true)`. Test fixtures only.
 */
export async function purgeBillingFixtures(patientIds: string[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    if (patientIds.length > 0) {
      const invoiceIds = (await tx.select({ id: invoices.id }).from(invoices).where(inArray(invoices.patientId, patientIds))).map((r) => r.id)
      await tx.delete(refunds).where(inArray(refunds.patientId, patientIds))
      await tx.delete(patientPayments).where(inArray(patientPayments.patientId, patientIds))
      if (invoiceIds.length > 0) {
        await tx.delete(creditNotes).where(inArray(creditNotes.invoiceId, invoiceIds))
        await tx.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, invoiceIds))
      }
      await tx.delete(chargeLines).where(inArray(chargeLines.patientId, patientIds))
      await tx.delete(invoices).where(inArray(invoices.patientId, patientIds))
    }
    await tx.delete(documentCounters).where(eq(documentCounters.financialYear, TEST_FINANCIAL_YEAR))
  })
}
