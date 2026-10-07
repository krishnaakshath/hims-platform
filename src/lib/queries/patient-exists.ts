import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'

/**
 * Whether a patient row exists (selects only the id). Patient-scoped write
 * routes check this so an unknown anonId is a 404, not a foreign-key 500.
 */
export async function patientExists(anonId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, anonId)).limit(1)
  return row !== undefined
}
