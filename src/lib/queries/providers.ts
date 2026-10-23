import { getDb } from '@/db/client'
import { providers, serviceCatalog, tariffRates } from '@/db/schema'
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { istDateOf } from '@/lib/india-time'
import type { ProviderProfileInput } from '@/lib/validation/provider-profile'
import { getOrSetCache, invalidateCache, providersListCacheKey } from '@/lib/cache'
import type { WriteExecutor } from './executor'

export async function listActiveProviders() {
  return getOrSetCache(providersListCacheKey(), 60, async () => {
    return getDb().select().from(providers).where(eq(providers.isActive, true))
  })
}

/** Full roster (active and inactive) for the Settings > Provider Profiles panel. */
export async function listAllProviders() {
  return getDb().select().from(providers)
}

export async function getProviderById(id: number) {
  const [row] = await getDb().select().from(providers).where(eq(providers.id, id))
  return row ?? null
}

/**
 * Partial profile update. Only keys present in the patch are written; a
 * non-SMC council clears the state so the row never keeps a stale one.
 */
export async function updateProviderProfile(id: number, patch: ProviderProfileInput): Promise<typeof providers.$inferSelect | null> {
  const set: Partial<typeof providers.$inferInsert> = {}
  if (patch.name !== undefined) set.name = patch.name
  if (patch.departmentId !== undefined) set.departmentId = patch.departmentId
  if (patch.registrationCouncil !== undefined) {
    set.registrationCouncil = patch.registrationCouncil
    if (patch.registrationCouncil !== 'smc') set.registrationStateCode = null
  }
  if (patch.registrationStateCode !== undefined) set.registrationStateCode = patch.registrationStateCode
  if (patch.registrationNumber !== undefined) set.registrationNumber = patch.registrationNumber
  if (patch.consultationFeePaise !== undefined) set.consultationFeePaise = patch.consultationFeePaise
  const [updated] = await getDb().update(providers).set(set).where(eq(providers.id, id)).returning()
  await invalidateCache(providersListCacheKey())
  return updated ?? null
}

// Foundations T10: the consultation fee has ONE source, the tariff. The stored
// providers.consultation_fee_paise column is kept but never used for a price decision.

/**
 * The consultation service of each department: its lowest-id active 'consultation' service
 * (Foundations T10 rule). WS2 T9: the fee shown and the line charged at check-in use this one service.
 */
async function consultationServiceIds(executor: WriteExecutor, departmentId?: number): Promise<Map<number, number>> {
  const rows = await executor
    .select({ departmentId: serviceCatalog.departmentId, serviceId: sql<number>`min(${serviceCatalog.id})::int` })
    .from(serviceCatalog)
    .where(and(
      eq(serviceCatalog.category, 'consultation'),
      eq(serviceCatalog.isActive, true),
      departmentId === undefined ? undefined : eq(serviceCatalog.departmentId, departmentId),
    ))
    .groupBy(serviceCatalog.departmentId)
  return new Map(rows.map((r) => [r.departmentId, r.serviceId]))
}

/** WS2 T9: the department's consultation service id, or null when it has none. */
export async function consultationServiceIdFor(executor: WriteExecutor, departmentId: number): Promise<number | null> {
  return (await consultationServiceIds(executor, departmentId)).get(departmentId) ?? null
}

/** Current base rate (paise) of each department's consultation service, keyed by department id. */
async function currentConsultationRates(departmentId?: number, now = new Date()): Promise<Map<number, number>> {
  const today = istDateOf(now)
  const db = getDb()
  const services = await consultationServiceIds(db, departmentId)
  const out = new Map<number, number>()
  if (services.size === 0) return out
  const departmentOf = new Map([...services].map(([dep, svc]) => [svc, dep]))
  const rows = await db
    .select({ serviceId: tariffRates.serviceId, amountPaise: tariffRates.amountPaise })
    .from(tariffRates)
    .where(and(
      inArray(tariffRates.serviceId, [...services.values()]),
      eq(tariffRates.scope, 'base'),
      isNull(tariffRates.deactivatedAt),
      lte(tariffRates.validFrom, today),
      or(isNull(tariffRates.validTo), gte(tariffRates.validTo, today)),
    ))
    .orderBy(desc(tariffRates.validFrom), desc(tariffRates.id))
  for (const r of rows) {
    // The newest valid base rate of the department's consultation service.
    const dep = departmentOf.get(r.serviceId)
    if (dep !== undefined && !out.has(dep)) out.set(dep, r.amountPaise)
  }
  return out
}

/** A doctor's consultation fee in paise from the tariff, or null (no department or no current consultation rate). */
export async function consultationFeePaise(providerId: number): Promise<number | null> {
  const [p] = await getDb().select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, providerId))
  if (!p || p.departmentId === null) return null
  return (await currentConsultationRates(p.departmentId)).get(p.departmentId) ?? null
}

/** The roster with each doctor's tariff-derived fee (read-only display). */
export async function listAllProvidersWithTariffFee() {
  const [rows, rates] = await Promise.all([listAllProviders(), currentConsultationRates()])
  return rows.map((p) => ({ ...p, tariffFeePaise: p.departmentId === null ? null : rates.get(p.departmentId) ?? null }))
}
// end Foundations T10
