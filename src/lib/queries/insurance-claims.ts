import { getDb } from '@/db/client'
import { insuranceClaims, charges, patients } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, insuranceClaimsListCacheKey } from '@/lib/cache'

export async function listInsuranceClaims() {
  return getOrSetCache(insuranceClaimsListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ claim: insuranceClaims, charge: charges, patient: patients })
      .from(insuranceClaims)
      .innerJoin(charges, eq(insuranceClaims.chargeId, charges.id))
      .innerJoin(patients, eq(insuranceClaims.patientId, patients.id))
      // Tiebreak on id so rows sharing a submittedDate keep a stable order
      // across requests (Postgres doesn't guarantee tie order otherwise).
      .orderBy(desc(insuranceClaims.submittedDate), desc(insuranceClaims.id))
    return rows.map((r) => ({
      ...r.claim,
      patientName: r.patient.name,
      dateOfService: r.charge.dateOfService,
    }))
  })
}
