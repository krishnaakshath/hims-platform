import { getDb } from '@/db/client'
import { labTests } from '@/db/schema'
import { asc } from 'drizzle-orm'

export async function listLabTests() {
  return getDb().select().from(labTests).orderBy(asc(labTests.name))
}
