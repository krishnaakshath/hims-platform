// WS1 T2: vitals and the consultation record for one encounter. Callers (routes) have already run
// the role gate and checkEncounterWriter; the writes here still re-read the encounter's status
// under a row lock, because that check ran outside any transaction and a visit completing between
// the check and the write must not take a late vitals set or consult edit.
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  diagnoses, encounterConsults, encounterVitals, encounters, providers,
  type EncounterConsultRow, type EncounterRow, type EncounterVitalsRow,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { ConsultPatch } from '@/lib/encounters/consult-validation'
import { toVitalsColumns, type VitalsInput } from '@/lib/encounters/vitals'
import { liveDiagnosis } from './diagnoses'

export class EncounterClosedError extends Error {
  constructor() { super('Visit is closed'); this.name = 'EncounterClosedError' }
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

// Share-locks the encounter row so a completion (which updates it) waits for this write.
async function assertOpen(tx: Tx, encounterId: number): Promise<void> {
  const [row] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, encounterId)).for('share')
  if (!row || row.status === 'completed' || row.status === 'cancelled') throw new EncounterClosedError()
}

export async function addVitals(encounter: EncounterRow, input: VitalsInput, session: Session): Promise<EncounterVitalsRow> {
  return getDb().transaction(async (tx) => {
    await assertOpen(tx, encounter.id)
    return insertVitalsInTx(tx, { encounterId: encounter.id, patientId: encounter.patientId }, input, session)
  })
}

/**
 * WS3 T7: the one encounter_vitals insert, shared by the visit workspace (addVitals) and the
 * nursing station (recordVitals). Callers have already locked and checked whatever makes the
 * write legal (an open visit; an admitted patient). `recordedAt` absent = the column default (now).
 */
export async function insertVitalsInTx(
  tx: Tx,
  target: { encounterId: number; patientId: string; recordedAt?: Date },
  input: VitalsInput,
  session: Session,
): Promise<EncounterVitalsRow> {
  const [row] = await tx.insert(encounterVitals).values({
    encounterId: target.encounterId,
    patientId: target.patientId,
    ...(target.recordedAt ? { recordedAt: target.recordedAt } : {}),
    recordedByName: session.name,
    recordedByUserId: session.userId ?? null,
    ...toVitalsColumns(input),
  }).returning()
  return row
}

export async function listVitals(encounterId: number): Promise<EncounterVitalsRow[]> {
  return getDb().select().from(encounterVitals).where(eq(encounterVitals.encounterId, encounterId))
    .orderBy(desc(encounterVitals.recordedAt), desc(encounterVitals.id))
}

export async function upsertConsult(encounter: EncounterRow, patch: ConsultPatch, session: Session): Promise<EncounterConsultRow> {
  // Only the keys the caller sent change; an empty string is stored as null.
  const changes: Partial<typeof encounterConsults.$inferInsert> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    ;(changes as Record<string, string | null>)[key] = value === '' ? null : value
  }
  const now = new Date()
  return getDb().transaction(async (tx) => {
    await assertOpen(tx, encounter.id)
    const [row] = await tx.insert(encounterConsults).values({
      encounterId: encounter.id, patientId: encounter.patientId, updatedAt: now, updatedByName: session.name, ...changes,
    }).onConflictDoUpdate({
      target: encounterConsults.encounterId,
      set: { ...changes, updatedAt: now, updatedByName: session.name },
    }).returning()
    return row
  })
}

export async function getConsult(encounterId: number): Promise<EncounterConsultRow | null> {
  const [row] = await getDb().select().from(encounterConsults).where(eq(encounterConsults.encounterId, encounterId))
  return row ?? null
}

export interface PriorConsult {
  encounterId: number
  encounterDate: string
  providerName: string
  chiefComplaint: string | null
  diagnoses: string[]
}

/** The patient's most recent completed visits before this one (newest first), for context. */
export async function priorConsults(patientId: string, beforeEncounterId: number, limit = 5): Promise<PriorConsult[]> {
  const db = getDb()
  const rows = await db.select({
    encounterId: encounters.id,
    encounterDate: encounters.encounterDate,
    providerName: providers.name,
    chiefComplaint: encounterConsults.chiefComplaint,
  }).from(encounters)
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(encounterConsults, eq(encounterConsults.encounterId, encounters.id))
    .where(and(eq(encounters.patientId, patientId), eq(encounters.status, 'completed'), lt(encounters.id, beforeEncounterId)))
    .orderBy(desc(encounters.encounterDate), desc(encounters.id))
    .limit(limit)
  if (rows.length === 0) return []
  const dx = await db.select({
    encounterId: diagnoses.encounterId, description: diagnoses.description, codeDisplay: diagnoses.codeDisplay, sequence: diagnoses.sequence, id: diagnoses.id,
  }).from(diagnoses)
    .where(and(inArray(diagnoses.encounterId, rows.map((r) => r.encounterId)), liveDiagnosis))
    .orderBy(sql`${diagnoses.sequence} nulls last`, diagnoses.id)
  const byEncounter = new Map<number, string[]>()
  for (const d of dx) {
    if (d.encounterId == null) continue
    const list = byEncounter.get(d.encounterId) ?? []
    list.push(d.codeDisplay || d.description)
    byEncounter.set(d.encounterId, list)
  }
  return rows.map((r) => ({ ...r, diagnoses: byEncounter.get(r.encounterId) ?? [] }))
}
