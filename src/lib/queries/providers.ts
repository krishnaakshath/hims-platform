import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { ProviderProfileInput } from '@/lib/validation/provider-profile'
import { getOrSetCache, invalidateCache, providersListCacheKey } from '@/lib/cache'
import { isoDates } from '@/lib/cache-shape'

export async function listActiveProviders() {
  return getOrSetCache(providersListCacheKey(), 60, isoDates(async () => {
    return getDb().select().from(providers).where(eq(providers.isActive, true))
  }))
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
