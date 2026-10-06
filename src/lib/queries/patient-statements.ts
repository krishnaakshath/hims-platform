import { getDb } from '@/db/client'
import { patientStatements, patients } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, patientStatementsListCacheKey } from '@/lib/cache'

export async function listPatientStatements() {
  return getOrSetCache(patientStatementsListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ statement: patientStatements, patient: patients })
      .from(patientStatements)
      .innerJoin(patients, eq(patientStatements.patientId, patients.id))
      // Tiebreak on id so rows sharing a sentDate keep a stable order across
      // requests (Postgres doesn't guarantee tie order otherwise).
      .orderBy(desc(patientStatements.sentDate), desc(patientStatements.id))
    // `sentDate` is normalized to an ISO string here (rather than left as the
    // Date object Drizzle returns) so its shape is identical on a cache hit
    // and a cache miss -- getOrSetCache round-trips through Redis as JSON,
    // which silently turns a Date into a string on the way back out, so a
    // consumer doing `<` string comparisons against a raw Date object here
    // would work by accident on a cold cache and break on a warm one.
    return rows.map((r) => ({
      ...r.statement,
      sentDate: r.statement.sentDate.toISOString(),
      patientName: r.patient.name,
    }))
  })
}
