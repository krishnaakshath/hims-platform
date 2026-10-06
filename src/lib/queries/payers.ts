import { getDb } from '@/db/client'
import { payers } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'

export type Payer = typeof payers.$inferSelect

export async function listPayers(): Promise<Payer[]> {
  return getDb().select().from(payers).orderBy(asc(payers.payerType), asc(payers.name))
}

export async function getPayerById(id: number): Promise<Payer | null> {
  const [row] = await getDb().select().from(payers).where(eq(payers.id, id))
  return row ?? null
}

export async function getPayerName(payerId: number | null): Promise<string | null> {
  if (payerId === null) return null
  const payer = await getPayerById(payerId)
  return payer?.name ?? null
}
