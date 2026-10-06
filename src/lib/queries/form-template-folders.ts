import { getDb } from '@/db/client'
import { formTemplateFolders, formTemplates } from '@/db/schema'
import { and, asc, count, eq } from 'drizzle-orm'

export type FormTemplateFolder = typeof formTemplateFolders.$inferSelect

export interface FolderWithCount { id: number; name: string; sortOrder: number; activeTemplateCount: number }

// The single definition of "counts as filed and active" -- shared by
// listFormTemplateFolders' count/join and listActiveTemplatesInFolder's
// filter so the two can never drift apart (an archived template must never
// be counted here and then be absent from the list a click on that count
// opens, or vice versa).
const isActiveTemplate = eq(formTemplates.isActive, true)

export async function listFormTemplateFolders(): Promise<FolderWithCount[]> {
  const rows = await getDb()
    .select({
      id: formTemplateFolders.id,
      name: formTemplateFolders.name,
      sortOrder: formTemplateFolders.sortOrder,
      activeTemplateCount: count(formTemplates.id),
    })
    .from(formTemplateFolders)
    .leftJoin(
      formTemplates,
      and(eq(formTemplates.folderId, formTemplateFolders.id), isActiveTemplate),
    )
    .groupBy(formTemplateFolders.id, formTemplateFolders.name, formTemplateFolders.sortOrder)
    .orderBy(asc(formTemplateFolders.sortOrder), asc(formTemplateFolders.name))

  return rows.map((row) => ({ ...row, activeTemplateCount: Number(row.activeTemplateCount) }))
}

export async function getFormTemplateFolder(id: number): Promise<FormTemplateFolder | null> {
  const [folder] = await getDb().select().from(formTemplateFolders).where(eq(formTemplateFolders.id, id))
  return folder ?? null
}

export async function createFormTemplateFolder(name: string): Promise<FormTemplateFolder> {
  const [created] = await getDb().insert(formTemplateFolders).values({ name }).returning()
  return created
}

export async function renameFormTemplateFolder(id: number, name: string): Promise<boolean> {
  const updated = await getDb().update(formTemplateFolders).set({ name }).where(eq(formTemplateFolders.id, id)).returning()
  return updated.length > 0
}

// Two sequential writes, not a transaction, matching this codebase's
// existing non-transactional posture elsewhere. A folder delete never
// deletes a template -- refusing to delete a non-empty folder would just
// force staff through a manual un-file loop to reach the same end state
// (templates un-filed, folder gone), with no data at risk either way.
export async function deleteFormTemplateFolder(id: number): Promise<boolean> {
  await getDb().update(formTemplates).set({ folderId: null }).where(eq(formTemplates.folderId, id))
  const deleted = await getDb().delete(formTemplateFolders).where(eq(formTemplateFolders.id, id)).returning()
  return deleted.length > 0
}

export async function listActiveTemplatesInFolder(folderId: number): Promise<(typeof formTemplates.$inferSelect)[]> {
  return getDb().select().from(formTemplates).where(and(eq(formTemplates.folderId, folderId), isActiveTemplate))
}

export async function listArchivedTemplates(): Promise<(typeof formTemplates.$inferSelect)[]> {
  return getDb().select().from(formTemplates).where(eq(formTemplates.isActive, false))
}

export async function countArchivedTemplates(): Promise<number> {
  const [row] = await getDb().select({ value: count() }).from(formTemplates).where(eq(formTemplates.isActive, false))
  return Number(row?.value ?? 0)
}
