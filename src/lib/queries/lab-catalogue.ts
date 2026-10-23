// WS4 T13 (spec 3.6 item 27): one source for the lab catalogue. Every lab test is created from a
// tariff service: Settings -> Lab setup -> "Add from tariff" lists the active lab, imaging and
// procedure services that have no test yet, and creates one test per picked service (code and
// name copied from the service, mapped to it, active). All-or-nothing in one transaction; the
// audit row carries the count only.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, labTests, serviceCatalog } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { labCategoryForService } from '@/lib/labs/catalog'

export const TARIFF_TEST_CATEGORIES = ['investigation_lab', 'investigation_imaging', 'procedure'] as const
export type TariffTestCategory = (typeof TARIFF_TEST_CATEGORIES)[number]

export interface TariffTestCandidate {
  serviceId: number
  code: string
  name: string
  category: TariffTestCategory
  departmentName: string
  basePaise: number | null
}

export type CreateFromServicesError = 'service_not_found' | 'service_inactive' | 'already_has_test' | 'category_not_orderable'

export type CreateFromServicesResult =
  | { ok: true; created: { id: number; code: string; name: string }[] }
  | { ok: false; error: CreateFromServicesError; serviceId: number }

/** Active lab, imaging and procedure services that no lab test is mapped to, with today's base (list) price. */
export async function listTariffServicesWithoutTest(): Promise<TariffTestCandidate[]> {
  const today = istDateOf(new Date())
  // The outer column is written qualified (service_catalog.id): drizzle renders it unqualified,
  // which inside the subqueries would bind to the inner tables' columns.
  const rows = await getDb()
    .select({
      serviceId: serviceCatalog.id,
      code: serviceCatalog.code,
      name: serviceCatalog.name,
      category: serviceCatalog.category,
      departmentName: departments.name,
      basePaise: sql<number | null>`(
        select r.amount_paise from tariff_rates r
        where r.service_id = service_catalog.id and r.scope = 'base' and r.room_category_id is null and r.ward is null
          and r.deactivated_at is null and r.valid_from <= ${today}::date and (r.valid_to is null or r.valid_to >= ${today}::date)
        order by r.valid_from desc, r.id desc limit 1)`,
    })
    .from(serviceCatalog)
    .innerJoin(departments, eq(departments.id, serviceCatalog.departmentId))
    .where(and(
      eq(serviceCatalog.isActive, true),
      inArray(serviceCatalog.category, [...TARIFF_TEST_CATEGORIES]),
      sql`not exists (select 1 from lab_tests t where t.service_id = service_catalog.id)`,
    ))
    .orderBy(asc(serviceCatalog.category), asc(serviceCatalog.name), asc(serviceCatalog.id))
  return rows.map((r) => ({ ...r, category: r.category as TariffTestCategory, basePaise: r.basePaise === null ? null : Number(r.basePaise) }))
}

/**
 * Creates one lab test per service, in the order given. Refuses the whole batch (nothing written)
 * on the first service that is missing, inactive, already mapped to a test or not orderable
 * (a procedure only with `allowProcedure`, i.e. an admin picked it explicitly). The picked
 * service rows are locked, so two admins adding the same service cannot both create a test.
 */
export async function createLabTestsFromServices(
  serviceIds: number[],
  session: Session,
  opts?: { allowProcedure?: boolean },
): Promise<CreateFromServicesResult> {
  const ids = [...new Set(serviceIds)]
  if (ids.length === 0) return { ok: true, created: [] }
  return getDb().transaction(async (tx): Promise<CreateFromServicesResult> => {
    const services = await tx
      .select({ id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, category: serviceCatalog.category, isActive: serviceCatalog.isActive })
      .from(serviceCatalog)
      .where(inArray(serviceCatalog.id, ids))
      .orderBy(asc(serviceCatalog.id))
      .for('update')
    const byId = new Map(services.map((s) => [s.id, s]))
    const mapped = new Set((await tx
      .select({ serviceId: labTests.serviceId })
      .from(labTests)
      .where(inArray(labTests.serviceId, ids))).map((r) => r.serviceId))

    const values: (typeof labTests.$inferInsert)[] = []
    for (const id of ids) {
      const s = byId.get(id)
      if (!s) return { ok: false, error: 'service_not_found', serviceId: id }
      if (!s.isActive) return { ok: false, error: 'service_inactive', serviceId: id }
      if (mapped.has(id)) return { ok: false, error: 'already_has_test', serviceId: id }
      const category = labCategoryForService(s.category, opts)
      if (category === null) return { ok: false, error: 'category_not_orderable', serviceId: id }
      values.push({ code: s.code, name: s.name, category, serviceId: id, isActive: true })
    }
    const created = await tx.insert(labTests).values(values).returning({ id: labTests.id, code: labTests.code, name: labTests.name, serviceId: labTests.serviceId })
    await logAudit(session, 'created lab tests from tariff', null, `count=${created.length}`, tx)
    const order = new Map(ids.map((id, i) => [id, i]))
    created.sort((a, b) => order.get(a.serviceId!)! - order.get(b.serviceId!)!)
    return { ok: true, created: created.map(({ id, code, name }) => ({ id, code, name })) }
  })
}
