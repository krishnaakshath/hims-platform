import { getDb } from '@/db/client'
import { formTemplates } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, formTemplatesListCacheKey } from '@/lib/cache'
import { isoDates } from '@/lib/cache-shape'

export async function listFormTemplates() {
  return getOrSetCache(formTemplatesListCacheKey(), 30, isoDates(async () => {
    return getDb().select().from(formTemplates)
  }))
}

export async function getFormTemplate(id: number) {
  const [template] = await getDb().select().from(formTemplates).where(eq(formTemplates.id, id))
  return template ?? null
}

export async function invalidateFormTemplatesList() {
  await invalidateCache(formTemplatesListCacheKey())
}
