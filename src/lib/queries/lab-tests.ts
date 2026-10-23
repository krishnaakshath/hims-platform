import { getDb } from '@/db/client'
import { labTests } from '@/db/schema'
import { asc, sql } from 'drizzle-orm'
import { istDateOf } from '@/lib/india-time'

/**
 * Foundations T10: each test also carries `priced` (display only; the order route re-checks with the
 * real resolver): its service is active and has a current, non-deactivated base rate.
 */
export async function listLabTests() {
  const today = istDateOf(new Date())
  return getDb()
    .select({
      id: labTests.id, name: labTests.name, code: labTests.code, category: labTests.category,
      defaultUnit: labTests.defaultUnit, referenceRange: labTests.referenceRange,
      sampleType: labTests.sampleType, container: labTests.container, serviceId: labTests.serviceId, isActive: labTests.isActive,
      priced: sql<boolean>`exists (
        select 1 from service_catalog s join tariff_rates r on r.service_id = s.id
        where s.id = ${labTests.serviceId} and s.is_active and r.scope = 'base' and r.deactivated_at is null
          and r.valid_from <= ${today}::date and (r.valid_to is null or r.valid_to >= ${today}::date))`,
    })
    .from(labTests)
    .orderBy(asc(labTests.name))
}
