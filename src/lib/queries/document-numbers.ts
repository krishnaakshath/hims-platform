// SP4: gapless document numbering per series and financial year (plan ruling 1).
// The counter row is incremented with UPDATE … RETURNING inside the caller's transaction: the row
// lock serialises concurrent finalisations, and a rollback undoes the increment, so a failed
// finalise burns no number.
import { and, eq, sql } from 'drizzle-orm'
import { documentCounters } from '@/db/schema'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { formatDocumentNumber, type DocumentSeries } from '@/lib/billing/numbering'
import type { WriteExecutor } from './executor'

export class SeriesExhaustedError extends Error {
  constructor() {
    super('The document number series for this financial year is full')
    this.name = 'SeriesExhaustedError'
  }
}

/** Must run inside the caller's transaction. Throws SeriesExhaustedError past 999999. */
export async function allocateDocumentNumber(executor: WriteExecutor, series: DocumentSeries, financialYear: string): Promise<string> {
  await executor.insert(documentCounters).values({ series, financialYear, lastValue: 0 }).onConflictDoNothing()
  let value: number
  try {
    const [row] = await executor.update(documentCounters).set({ lastValue: sql`${documentCounters.lastValue} + 1` })
      .where(and(eq(documentCounters.series, series), eq(documentCounters.financialYear, financialYear)))
      .returning({ value: documentCounters.lastValue })
    value = row.value
  } catch (err) {
    if (pgErrorCode(err) === '23514' && pgConstraint(err) === 'document_counters_value_range') throw new SeriesExhaustedError()
    throw err
  }
  return formatDocumentNumber(series, financialYear, value)
}
