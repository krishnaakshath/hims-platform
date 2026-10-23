import { getDb } from '@/db/client'
import { departments, providers, serviceCatalog, tariffRates } from '@/db/schema'
import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm'
import { istDateOf } from '@/lib/india-time'
import type { ProviderProfileInput } from '@/lib/validation/provider-profile'
import { getOrSetCache, invalidateCache, providersListCacheKey } from '@/lib/cache'

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
  if (patch.opdRoom !== undefined) set.opdRoom = patch.opdRoom // WS6 T6
  if (patch.portalBookable !== undefined) set.portalBookable = patch.portalBookable // WS6 T6
  const [updated] = await getDb().update(providers).set(set).where(eq(providers.id, id)).returning()
  await invalidateCache(providersListCacheKey())
  return updated ?? null
}

// Foundations T10: the consultation fee has ONE source, the tariff. The stored
// providers.consultation_fee_paise column is kept but never used for a price decision.

/** Current base rate (paise) of each department's active consultation service, keyed by department id. */
async function currentConsultationRates(departmentId?: number, now = new Date()): Promise<Map<number, number>> {
  const today = istDateOf(now)
  const rows = await getDb()
    .select({ departmentId: serviceCatalog.departmentId, serviceId: serviceCatalog.id, amountPaise: tariffRates.amountPaise })
    .from(serviceCatalog)
    .innerJoin(tariffRates, eq(tariffRates.serviceId, serviceCatalog.id))
    .where(and(
      eq(serviceCatalog.category, 'consultation'),
      eq(serviceCatalog.isActive, true),
      departmentId === undefined ? undefined : eq(serviceCatalog.departmentId, departmentId),
      eq(tariffRates.scope, 'base'),
      isNull(tariffRates.deactivatedAt),
      lte(tariffRates.validFrom, today),
      or(isNull(tariffRates.validTo), gte(tariffRates.validTo, today)),
    ))
    .orderBy(serviceCatalog.id, desc(tariffRates.validFrom), desc(tariffRates.id))
  const out = new Map<number, number>()
  const seenService = new Map<number, number>()
  for (const r of rows) {
    // First consultation service of the department (lowest id) wins; its newest valid rate.
    const owner = seenService.get(r.departmentId)
    if (owner === undefined) { seenService.set(r.departmentId, r.serviceId); out.set(r.departmentId, r.amountPaise) }
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

// WS6 T8 (spec D6): active doctors in active clinical departments, for the registration
// dialog's "Next available" hint. Ids, names, department and OPD room only.
export interface ClinicalDoctor {
  id: number
  name: string
  departmentId: number
  departmentName: string
  opdRoom: string | null
}

export async function listClinicalDoctors(): Promise<ClinicalDoctor[]> {
  const rows = await getDb()
    .select({ id: providers.id, name: providers.name, departmentId: departments.id, departmentName: departments.name, opdRoom: providers.opdRoom })
    .from(providers)
    .innerJoin(departments, eq(providers.departmentId, departments.id))
    .where(and(eq(providers.isActive, true), eq(departments.isActive, true), eq(departments.kind, 'clinical')))
    .orderBy(departments.name, providers.name, providers.id)
  return rows
}
// end WS6 T8
