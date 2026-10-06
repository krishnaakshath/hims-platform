import { getDb } from '@/db/client'
import { trials } from '@/db/schema'

export type Trial = typeof trials.$inferSelect

/** See the comment in `queries/patients.ts` — shared by the API route and Server Components alike. */
export async function listAllTrials(): Promise<Trial[]> {
  return getDb().select().from(trials)
}
