import { getDb } from '@/db/client'
import { labTests } from '@/db/schema'
import { asc, sql } from 'drizzle-orm'
import { istDateOf } from '@/lib/india-time'

// WS2 T10: the outer column is written qualified (lab_tests.service_id): drizzle renders
// ${labTests.serviceId} unqualified, which inside these subqueries binds to tariff_rates.service_id
// (so `priced` was true for every test while any service had a rate).
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
        where s.id = lab_tests.service_id and s.is_active and r.scope = 'base' and r.deactivated_at is null
          and r.valid_from <= ${today}::date and (r.valid_to is null or r.valid_to >= ${today}::date))`,
      // WS2 T10: the current base (list) price shown on the order form; the order route prices the
      // line itself with the resolver (payer and department rates can differ). Null when unpriced.
      pricePaise: sql<number | null>`(
        select r.amount_paise from service_catalog s join tariff_rates r on r.service_id = s.id
        where s.id = lab_tests.service_id and s.is_active and r.scope = 'base' and r.room_category_id is null and r.ward is null and r.deactivated_at is null
          and r.valid_from <= ${today}::date and (r.valid_to is null or r.valid_to >= ${today}::date)
        order by r.valid_from desc, r.id desc limit 1)`,
      fastingRequired: labTests.fastingRequired, // WS2 T10
    })
    .from(labTests)
    .orderBy(asc(labTests.name))
}
