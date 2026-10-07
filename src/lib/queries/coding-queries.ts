// Coding queries to doctors with a response log (SP6 Task 8). Same lock order as coding.ts:
// the encounter's `encounter_coding` row FIRST (lockEncounterCoding), then the query row FOR
// UPDATE. Each write is one transaction with its audit row inside it. Question and reply text
// live in their tables only; audit details carry ids and enum values (ruling 14).
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { codingQueries, codingQueryResponses, encounterCoding, encounterCodingEvents, encounters, patients, providers } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { CodingWriteError, CodingWriteResult } from '@/lib/coding/errors'
import { nextCodingStatus, type CodingQueryStatus } from '@/lib/coding/status'
import { lockEncounterCoding, runCodingTransaction, type LockedEncounterCoding } from './coding'
import type { WriteExecutor } from './executor'

const fail = (error: CodingWriteError): { ok: false; error: CodingWriteError } => ({ ok: false, error })

/** A coder acts only on an encounter they have claimed (ruling 7); admin is exempt. */
function lacksClaim(locked: LockedEncounterCoding, session: Session): boolean {
  return session.role === 'coder' && (session.userId === null || locked.coding.assignedToUserId !== session.userId)
}

export async function raiseCodingQuery(
  encounterId: number, input: { addressedToProviderId: number; question: string }, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ queryId: number }>> {
  return runCodingTransaction(async (tx) => {
    const locked = await lockEncounterCoding(tx, encounterId)
    if (!locked) return fail('not_found')
    const { coding, encounter } = locked
    if (encounter.status === 'cancelled') return fail('encounter_cancelled')
    if (encounter.status !== 'completed') return fail('encounter_not_completed')
    const to = nextCodingStatus(coding.status, 'raise_query')
    if (to === null) return fail('invalid_transition')
    if (lacksClaim(locked, session)) return fail('not_claimed')
    const [doc] = await tx.select({ id: providers.id }).from(providers)
      .where(and(eq(providers.id, input.addressedToProviderId), eq(providers.isActive, true)))
    if (!doc) return fail('provider_not_found')

    const [q] = await tx.insert(codingQueries).values({
      encounterId, patientId: encounter.patientId, addressedToProviderId: doc.id, question: input.question,
      status: 'open', raisedByName: session.name, raisedByUserId: session.userId, raisedAt: now,
    }).returning({ id: codingQueries.id })
    await tx.update(encounterCoding).set({ status: to, updatedAt: now }).where(eq(encounterCoding.encounterId, encounterId))
    await tx.insert(encounterCodingEvents).values({
      encounterId, action: 'raise_query', fromStatus: coding.status, toStatus: to, reason: null,
      byName: session.name, byUserId: session.userId, at: now,
    })
    await logAudit(session, 'coding: raised query', encounter.patientId, `encounter=${encounterId} query=${q.id} to=provider:${doc.id}`, tx)
    return { ok: true, value: { queryId: q.id } }
  })
}

/** Locks the query's encounter coding row first, then the query row. */
async function lockQuery(tx: WriteExecutor, queryId: number) {
  const [ref] = await tx.select({ encounterId: codingQueries.encounterId }).from(codingQueries).where(eq(codingQueries.id, queryId))
  if (!ref) return null
  const locked = await lockEncounterCoding(tx, ref.encounterId)
  if (!locked) return null
  const [q] = await tx
    .select({ id: codingQueries.id, encounterId: codingQueries.encounterId, patientId: codingQueries.patientId, status: codingQueries.status })
    .from(codingQueries).where(eq(codingQueries.id, queryId)).for('update')
  return q ? { locked, query: q } : null
}

const isClosed = (s: CodingQueryStatus) => s === 'closed' || s === 'withdrawn'

/**
 * Any pi/admin (cross-cover, ruling 8) or the coder may reply. A pi/admin reply on an `open`
 * query marks it `answered`; a coder's reply leaves the status as it is.
 */
export async function respondToCodingQuery(
  queryId: number, body: string, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ responseId: number }>> {
  return runCodingTransaction(async (tx) => {
    const l = await lockQuery(tx, queryId)
    if (!l) return fail('query_not_found')
    const { query } = l
    if (isClosed(query.status)) return fail('query_closed')
    const [r] = await tx.insert(codingQueryResponses).values({
      queryId, authorName: session.name, authorRole: session.role, body, createdAt: now,
    }).returning({ id: codingQueryResponses.id })
    if (query.status === 'open' && (session.role === 'pi' || session.role === 'admin')) {
      await tx.update(codingQueries).set({ status: 'answered', answeredAt: now }).where(eq(codingQueries.id, queryId))
    }
    await logAudit(session, 'coding: responded to query', query.patientId, `query=${queryId} encounter=${query.encounterId}`, tx)
    return { ok: true, value: { responseId: r.id } }
  })
}

/** open/answered → closed or withdrawn. A coder must hold the encounter's claim. */
export async function closeCodingQuery(
  queryId: number, action: 'close' | 'withdraw', session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ status: CodingQueryStatus }>> {
  return runCodingTransaction(async (tx) => {
    const l = await lockQuery(tx, queryId)
    if (!l) return fail('query_not_found')
    const { query, locked } = l
    if (isClosed(query.status)) return fail('query_closed')
    if (lacksClaim(locked, session)) return fail('not_claimed')
    const status: CodingQueryStatus = action === 'close' ? 'closed' : 'withdrawn'
    await tx.update(codingQueries).set({ status, closedAt: now, closedByName: session.name }).where(eq(codingQueries.id, queryId))
    await logAudit(session, action === 'close' ? 'coding: closed query' : 'coding: withdrew query', query.patientId,
      `query=${queryId} encounter=${query.encounterId}`, tx)
    return { ok: true, value: { status } }
  })
}

export interface ProviderCodingQuery {
  queryId: number
  encounterId: number
  patientId: string
  patientName: string
  uhid: string | null
  encounterDate: string
  question: string
  raisedByName: string
  raisedAt: Date
}

/** The addressed doctor's `open` queries, oldest first (doctor-facing; named patient columns). */
export async function listOpenCodingQueriesForProvider(providerId: number): Promise<ProviderCodingQuery[]> {
  return getDb()
    .select({
      queryId: codingQueries.id,
      encounterId: codingQueries.encounterId,
      patientId: codingQueries.patientId,
      patientName: patients.name,
      uhid: patients.uhid,
      encounterDate: encounters.encounterDate,
      question: codingQueries.question,
      raisedByName: codingQueries.raisedByName,
      raisedAt: codingQueries.raisedAt,
    })
    .from(codingQueries)
    .innerJoin(encounters, eq(encounters.id, codingQueries.encounterId))
    .innerJoin(patients, eq(patients.id, codingQueries.patientId))
    .where(and(eq(codingQueries.addressedToProviderId, providerId), eq(codingQueries.status, 'open')))
    .orderBy(asc(codingQueries.raisedAt), asc(codingQueries.id))
}
