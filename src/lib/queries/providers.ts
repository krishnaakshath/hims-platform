import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { eq } from 'drizzle-orm'
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

/** Name-only edit — Provider Profiles is a lightweight roster editor, not a full provider-management form. */
export async function updateProviderName(id: number, name: string) {
  const [updated] = await getDb().update(providers).set({ name }).where(eq(providers.id, id)).returning()
  await invalidateCache(providersListCacheKey())
  return updated ?? null
}
