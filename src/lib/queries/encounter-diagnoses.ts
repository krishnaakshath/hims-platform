// WS1 T4 (spec ruling 5): the doctor's diagnoses from the consultation workspace go through SP6's
// `diagnoses` columns, not around them. A coded pick must be a code of the current, non-sample WHO
// ICD-10 version and is written `proposed` (the coder confirms it); free text is `uncoded` with
// code ''. Once SP6 marks the encounter coded/finalised, doctor edits are refused (coding_locked)
// and the doctor raises it through the coding query instead. Removal is SP6's soft void.
//
// Lock order is SP6's (src/lib/queries/coding.ts): the encounter's coding row first
// (lockEncounterCoding), then the encounter row FOR SHARE (a cancel waits), then the diagnosis.
// Callers (routes) have already run the role gate and checkEncounterWriter. Each write is one
// transaction with its audit row; the audit names ids only, never the diagnosis text or code.
import { and, asc, desc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { diagnoses, encounterCoding, encounters, type DiagnosisRow, type EncounterRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { doctorMayPropose } from '@/lib/coding/status'
import { isUniqueViolation } from '@/lib/db-errors'
import type { AddDiagnosis, DiagnosisError, PatchDiagnosis } from '@/lib/encounters/diagnosis-validation'
import { findCurrentCode, getCodesByIds } from './code-systems'
import { lockEncounterCoding } from './coding'
import { EncounterClosedError } from './encounter-clinical'
import { liveDiagnosis } from './diagnoses'
import type { WriteExecutor } from './executor'

type Failure = { ok: false; error: DiagnosisError }

// Thrown inside the transaction so a refused write leaves nothing behind (not even the lazily
// created coding row); never escapes this module.
class Rollback extends Error {
  constructor(readonly result: Failure) { super(result.error) }
}

async function inTransaction<T extends { ok: true }>(patientId: string, fn: (tx: WriteExecutor) => Promise<T | Failure>): Promise<T | Failure> {
  let result: T | Failure
  try {
    result = await getDb().transaction(async (tx) => {
      const r = await fn(tx)
      if (!r.ok) throw new Rollback(r)
      return r
    })
  } catch (err) {
    if (err instanceof Rollback) return err.result
    // Backstop for two primaries racing past the in-transaction check.
    if (isUniqueViolation(err, 'diagnoses_one_primary_per_encounter')) return { ok: false, error: 'primary_exists' }
    throw err
  }
  await invalidateCache(patientDetailCacheKey(patientId))
  return result
}

/** The SP6 coding lock, then the visit's status under a share lock. */
async function guard(tx: WriteExecutor, encounterId: number): Promise<Failure | null> {
  const locked = await lockEncounterCoding(tx, encounterId)
  if (!locked) return { ok: false, error: 'not_found' }
  const [enc] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, encounterId)).for('share')
  if (!enc || enc.status === 'cancelled') throw new EncounterClosedError()
  if (!doctorMayPropose(locked.coding.status)) return { ok: false, error: 'coding_locked' }
  return null
}

async function touchCoding(tx: WriteExecutor, encounterId: number, now: Date): Promise<void> {
  await tx.update(encounterCoding).set({ updatedAt: now }).where(eq(encounterCoding.encounterId, encounterId))
}

async function hasOtherLivePrimary(tx: WriteExecutor, encounterId: number, exceptId: number | null): Promise<boolean> {
  const rows = await tx.select({ id: diagnoses.id }).from(diagnoses).where(and(
    eq(diagnoses.encounterId, encounterId), eq(diagnoses.diagnosisType, 'primary'), liveDiagnosis,
    exceptId === null ? undefined : ne(diagnoses.id, exceptId),
  )).limit(1)
  return rows.length > 0
}

/** A live diagnosis of this encounter, locked; null when absent, voided or another visit's. */
async function lockLiveDiagnosis(tx: WriteExecutor, encounterId: number, diagnosisId: number) {
  const [row] = await tx.select({ id: diagnoses.id, encounterId: diagnoses.encounterId, voidedAt: diagnoses.voidedAt, codingStatus: diagnoses.codingStatus, diagnosisType: diagnoses.diagnosisType })
    .from(diagnoses).where(eq(diagnoses.id, diagnosisId)).for('update')
  return row && row.encounterId === encounterId && row.voidedAt === null ? row : null
}

export async function addEncounterDiagnosis(encounter: EncounterRow, input: AddDiagnosis, session: Session):
  Promise<{ ok: true; diagnosis: DiagnosisRow } | { ok: false; error: DiagnosisError }> {
  return inTransaction(encounter.patientId, async (tx) => {
    const refused = await guard(tx, encounter.id)
    if (refused) return refused

    let coded: { id: number; code: string; display: string } | null = null
    if (input.codeId !== undefined) {
      const detail = (await getCodesByIds([input.codeId], tx)).get(input.codeId)
      if (!detail || detail.kind !== 'icd10' || detail.isSample || !detail.active || !detail.selectable) return { ok: false, error: 'code_not_current' }
      const current = await findCurrentCode('icd10', detail.code, tx)
      if (current?.id !== input.codeId) return { ok: false, error: 'code_not_current' }
      coded = { id: detail.id, code: detail.code, display: detail.display }
    }
    if (input.diagnosisType === 'primary' && await hasOtherLivePrimary(tx, encounter.id, null)) return { ok: false, error: 'primary_exists' }

    const now = new Date()
    const [row] = await tx.insert(diagnoses).values(coded ? {
      patientId: encounter.patientId, encounterId: encounter.id, codeId: coded.id, codeSystemKind: 'icd10',
      code: coded.code, codeDisplay: coded.display, description: coded.display,
      diagnosisType: input.diagnosisType, codingStatus: 'proposed', proposedByName: session.name, proposedAt: now,
      createdByName: session.name, createdAt: now, date: encounter.encounterDate, onProblemList: input.onProblemList ?? false,
    } : {
      patientId: encounter.patientId, encounterId: encounter.id, code: '', description: input.text ?? '',
      diagnosisType: input.diagnosisType, codingStatus: 'uncoded',
      createdByName: session.name, createdAt: now, date: encounter.encounterDate, onProblemList: input.onProblemList ?? false,
    }).returning()
    await touchCoding(tx, encounter.id, now)
    await logAudit(session, 'added diagnosis', encounter.patientId,
      `encounter=${encounter.id} diagnosis=${row.id} type=${row.diagnosisType} status=${row.codingStatus}`, tx)
    return { ok: true as const, diagnosis: row }
  })
}

export async function updateEncounterDiagnosis(encounter: EncounterRow, diagnosisId: number, patch: PatchDiagnosis, session: Session):
  Promise<{ ok: true } | { ok: false; error: DiagnosisError }> {
  return inTransaction(encounter.patientId, async (tx) => {
    const refused = await guard(tx, encounter.id)
    if (refused) return refused
    const row = await lockLiveDiagnosis(tx, encounter.id, diagnosisId)
    if (!row) return { ok: false, error: 'not_found' }
    // A diagnosis the coder has confirmed is the coder's to change.
    if (row.codingStatus === 'coded') return { ok: false, error: 'coding_locked' }
    if (patch.diagnosisType === 'primary' && row.diagnosisType !== 'primary' && await hasOtherLivePrimary(tx, encounter.id, diagnosisId)) {
      return { ok: false, error: 'primary_exists' }
    }
    const set: Partial<typeof diagnoses.$inferInsert> = {}
    if (patch.diagnosisType !== undefined) set.diagnosisType = patch.diagnosisType
    if (patch.onProblemList !== undefined) set.onProblemList = patch.onProblemList
    if (Object.keys(set).length > 0) await tx.update(diagnoses).set(set).where(eq(diagnoses.id, diagnosisId))
    await touchCoding(tx, encounter.id, new Date())
    await logAudit(session, 'changed diagnosis', encounter.patientId,
      `encounter=${encounter.id} diagnosis=${diagnosisId} type=${patch.diagnosisType ?? row.diagnosisType ?? 'none'}${patch.onProblemList === undefined ? '' : ` problemList=${patch.onProblemList}`}`, tx)
    return { ok: true as const }
  })
}

export async function voidEncounterDiagnosis(encounter: EncounterRow, diagnosisId: number, session: Session):
  Promise<{ ok: true } | { ok: false; error: DiagnosisError }> {
  return inTransaction(encounter.patientId, async (tx) => {
    const refused = await guard(tx, encounter.id)
    if (refused) return refused
    const row = await lockLiveDiagnosis(tx, encounter.id, diagnosisId)
    if (!row) return { ok: false, error: 'not_found' }
    if (row.codingStatus === 'coded') return { ok: false, error: 'coding_locked' }
    const now = new Date()
    await tx.update(diagnoses).set({ voidedAt: now, voidedByName: session.name }).where(eq(diagnoses.id, diagnosisId))
    await touchCoding(tx, encounter.id, now)
    await logAudit(session, 'removed diagnosis', encounter.patientId, `encounter=${encounter.id} diagnosis=${diagnosisId}`, tx)
    return { ok: true as const }
  })
}

/** The visit's live diagnoses: primary first, then in the order they were added. */
export async function listEncounterDiagnoses(encounterId: number): Promise<DiagnosisRow[]> {
  return getDb().select().from(diagnoses).where(and(eq(diagnoses.encounterId, encounterId), liveDiagnosis))
    .orderBy(sql`(${diagnoses.diagnosisType} = 'primary') DESC NULLS LAST`, asc(diagnoses.id))
}

/**
 * The patient's problem list: live diagnoses flagged onto it, plus legacy diagnoses recorded
 * without a visit (the chart's original problem list). Newest first.
 */
export async function listProblemList(patientId: string): Promise<{ id: number; label: string; code: string | null; since: string | null }[]> {
  const rows = await getDb().select({ id: diagnoses.id, codeDisplay: diagnoses.codeDisplay, description: diagnoses.description, code: diagnoses.code, date: diagnoses.date })
    .from(diagnoses)
    .where(and(eq(diagnoses.patientId, patientId), liveDiagnosis, or(eq(diagnoses.onProblemList, true), isNull(diagnoses.encounterId))))
    .orderBy(sql`${diagnoses.date} DESC NULLS LAST`, desc(diagnoses.id))
  return rows.map((r) => ({ id: r.id, label: r.codeDisplay || r.description, code: r.code === '' ? null : r.code, since: r.date }))
}
