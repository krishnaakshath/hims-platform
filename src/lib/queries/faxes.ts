import { getDb } from '@/db/client'
import { faxes, patients } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, faxesListCacheKey } from '@/lib/cache'

export async function listFaxes() {
  return getOrSetCache(faxesListCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ fax: faxes, patient: patients })
      .from(faxes)
      .leftJoin(patients, eq(faxes.patientId, patients.id))
      // Stable order -- see the comment in documents.ts's listDocuments()
      // for why an unordered query here is a real bug, not just tidiness.
      .orderBy(desc(faxes.faxDate), desc(faxes.id))

    return rows.map((r) => ({
      ...r.fax,
      // faxDate is a `timestamp` column -- a real Date on a fresh DB read,
      // a plain string after this function's own Redis round-trip on a
      // cache hit (the same hazard already fixed for patientStatements.sentDate
      // and reports.ts's visitDate). Normalize up front so callers see one
      // consistent shape either way.
      faxDate: r.fax.faxDate.toISOString(),
      patientName: r.patient ? r.patient.name : null,
      patientDob: r.patient ? r.patient.dob : null,
    }))
  })
}
