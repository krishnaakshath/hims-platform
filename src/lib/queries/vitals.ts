// WS3 T7: nursing vitals for an admission. Lane ruling R4: the readings are encounter_vitals rows on
// the admission's IPD encounter (encounters.admission_id, created by admitPatient), written through
// the same insert as the visit workspace (insertVitalsInTx).
import { and, asc, eq, gte } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, encounterVitals, encounters, type EncounterVitalsRow } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { NursingVitalsRequest } from '@/lib/inpatient/vitals'
import { insertVitalsInTx } from './encounter-clinical'

export type RecordVitalsResult =
  | { ok: true; id: number; row: EncounterVitalsRow }
  | { ok: false; error: 'not_found' | 'not_admitted' | 'no_ipd_encounter' }

/**
 * Records one reading on the admission's IPD encounter. Lock order matches dischargeAdmission
 * (IPD encounter row, then the admission row), so a discharge racing this write either commits
 * first (this write then sees 'discharged') or waits for it.
 */
export async function recordVitals(admissionId: number, input: NursingVitalsRequest, session: Session): Promise<RecordVitalsResult> {
  return getDb().transaction(async (tx): Promise<RecordVitalsResult> => {
    const [encounter] = await tx.select({ id: encounters.id, patientId: encounters.patientId }).from(encounters)
      .where(and(eq(encounters.admissionId, admissionId), eq(encounters.encounterType, 'ipd'))).for('share')
    const [admission] = await tx.select({ status: admissions.status, patientId: admissions.patientId }).from(admissions)
      .where(eq(admissions.id, admissionId)).for('share')
    if (!admission) return { ok: false, error: 'not_found' }
    if (admission.status !== 'admitted') return { ok: false, error: 'not_admitted' }
    if (!encounter) return { ok: false, error: 'no_ipd_encounter' }
    const row = await insertVitalsInTx(tx, { encounterId: encounter.id, patientId: admission.patientId, recordedAt: input.recordedAt }, input.reading, session)
    return { ok: true, id: row.id, row }
  })
}

/** The admission's readings taken in the last `sinceHours` (default 72), oldest first (chart order). */
export async function listVitals(admissionId: number, sinceHours = 72, now: Date = new Date()): Promise<EncounterVitalsRow[]> {
  const since = new Date(now.getTime() - sinceHours * 3600_000)
  return getDb().select({ v: encounterVitals }).from(encounterVitals)
    .innerJoin(encounters, eq(encounters.id, encounterVitals.encounterId))
    .where(and(eq(encounters.admissionId, admissionId), eq(encounters.encounterType, 'ipd'), gte(encounterVitals.recordedAt, since)))
    .orderBy(asc(encounterVitals.recordedAt), asc(encounterVitals.id))
    .then((rows) => rows.map((r) => r.v))
}
