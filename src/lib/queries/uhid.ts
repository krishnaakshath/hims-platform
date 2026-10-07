import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { formatUhid, isValidUhidPrefix } from '@/lib/uhid'

export type DbExecutor = Pick<ReturnType<typeof getDb>, 'execute' | 'select'>

export async function getUhidPrefix(executor: DbExecutor = getDb()): Promise<string> {
  const [row] = await executor.select({ uhidPrefix: appSettings.uhidPrefix }).from(appSettings)
  return row?.uhidPrefix ?? 'UH'
}

export async function setUhidPrefix(prefix: string): Promise<void> {
  if (!isValidUhidPrefix(prefix)) throw new Error('Invalid UHID prefix')
  // Upsert: the single settings row (id 1) may not exist yet on a fresh DB.
  await getDb().insert(appSettings).values({ id: 1, uhidPrefix: prefix }).onConflictDoUpdate({ target: appSettings.id, set: { uhidPrefix: prefix } })
}

export async function nextUhid(executor: DbExecutor): Promise<string> {
  const res = await executor.execute(sql`select nextval('uhid_seq') as seq`)
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { seq: string | number }[]
  return formatUhid(await getUhidPrefix(executor), Number(rows[0].seq))
}
