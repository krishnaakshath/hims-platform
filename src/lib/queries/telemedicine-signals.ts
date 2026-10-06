import { and, asc, eq, gt } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { telemedicineSignals } from '@/db/schema'

export type TelemedicineSignalSender = 'provider' | 'patient'
export type TelemedicineSignalType = 'offer' | 'answer' | 'ice_candidate'

export interface TelemedicineSignalRow {
  id: number
  sessionId: number
  sender: TelemedicineSignalSender
  signalType: TelemedicineSignalType
  payload: unknown
  createdAt: Date
}

export async function createSignal(sessionId: number, sender: TelemedicineSignalSender, signalType: TelemedicineSignalType, payload: unknown): Promise<{ id: number }> {
  const [row] = await getDb().insert(telemedicineSignals).values({ sessionId, sender, signalType, payload }).returning({ id: telemedicineSignals.id })
  return row
}

/** Returns rows *from* `sender`, ordered by id ascending -- a caller polling for the other side's messages passes the other side's sender value. */
export async function listSignalsSince(sessionId: number, sinceId: number, sender: TelemedicineSignalSender): Promise<TelemedicineSignalRow[]> {
  return getDb().select().from(telemedicineSignals)
    .where(and(eq(telemedicineSignals.sessionId, sessionId), eq(telemedicineSignals.sender, sender), gt(telemedicineSignals.id, sinceId)))
    .orderBy(asc(telemedicineSignals.id))
}
