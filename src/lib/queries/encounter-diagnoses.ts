// WS1 T4 (spec ruling 5): the doctor's diagnoses from the consultation workspace go THROUGH SP6
// (src/lib/queries/coding.ts), not around it: the writes below are SP6's own add/update/void with
// the workspace options (always the doctor actor, even for admin; only codes of the current,
// non-sample WHO ICD-10 version; the problem-list flag). So SP6's lock order, code checks (date,
// sex, age, heading), primary rule, `proposed`/`uncoded` statuses, soft void and audit rows apply
// unchanged. This module only translates SP6's outcome to the workspace's errors:
//   locked -> coding_locked; primary_exists; entry_not_found/not_found -> not_found;
//   code_not_found/code_not_current/sample_code -> code_not_current;
//   code_invalid -> code_not_valid_for_patient (sex/age) or code_not_current (inactive, heading, date);
//   encounter_cancelled -> EncounterClosedError (409 visit_closed).
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { diagnoses, type DiagnosisRow, type EncounterRow } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import type { CodingWriteError } from '@/lib/coding/errors'
import type { CodingIssue } from '@/lib/coding/rules'
import type { AddDiagnosis, DiagnosisError, PatchDiagnosis } from '@/lib/encounters/diagnosis-validation'
import {
  addEncounterDiagnosis as sp6AddDiagnosis, updateEncounterDiagnosis as sp6UpdateDiagnosis, voidEncounterDiagnosis as sp6VoidDiagnosis,
} from './coding'
import { EncounterClosedError } from './encounter-clinical'
import { liveDiagnosis } from './diagnoses'

export type DiagnosisFailure = { ok: false; error: DiagnosisError; issues?: CodingIssue[] }

const PATIENT_FIT_ISSUES = new Set(['sex_mismatch', 'age_out_of_range'])

function toWorkspaceError(error: CodingWriteError, issues: CodingIssue[] | undefined): DiagnosisFailure {
  switch (error) {
    case 'locked': return { ok: false, error: 'coding_locked' }
    case 'primary_exists': return { ok: false, error: 'primary_exists' }
    case 'not_found':
    case 'entry_not_found': return { ok: false, error: 'not_found' }
    case 'code_not_found':
    case 'code_not_current':
    case 'sample_code': return { ok: false, error: 'code_not_current' }
    case 'code_invalid':
      return issues?.some((i) => PATIENT_FIT_ISSUES.has(i.code))
        ? { ok: false, error: 'code_not_valid_for_patient', issues }
        : { ok: false, error: 'code_not_current', issues }
    case 'encounter_cancelled': throw new EncounterClosedError()
    default: throw new Error(`unexpected coding outcome ${error}`)
  }
}

const WORKSPACE = { asDoctor: true, currentIcd10Only: true } as const

export async function addEncounterDiagnosis(encounter: EncounterRow, input: AddDiagnosis, session: Session):
  Promise<{ ok: true; diagnosis: DiagnosisRow } | DiagnosisFailure> {
  const r = await sp6AddDiagnosis(encounter.id, {
    type: input.diagnosisType,
    ...(input.codeId !== undefined ? { codeId: input.codeId } : { description: input.text }),
  }, session, new Date(), { ...WORKSPACE, onProblemList: input.onProblemList ?? false })
  if (!r.ok) return toWorkspaceError(r.error, r.issues)
  await invalidateCache(patientDetailCacheKey(encounter.patientId))
  const [diagnosis] = await getDb().select().from(diagnoses).where(eq(diagnoses.id, r.value.diagnosisId))
  return { ok: true, diagnosis }
}

export async function updateEncounterDiagnosis(encounter: EncounterRow, diagnosisId: number, patch: PatchDiagnosis, session: Session):
  Promise<{ ok: true } | DiagnosisFailure> {
  const r = await sp6UpdateDiagnosis(encounter.id, diagnosisId, patch.diagnosisType !== undefined ? { type: patch.diagnosisType } : {},
    session, new Date(), { ...WORKSPACE, onProblemList: patch.onProblemList })
  if (!r.ok) return toWorkspaceError(r.error, r.issues)
  await invalidateCache(patientDetailCacheKey(encounter.patientId))
  return { ok: true }
}

export async function voidEncounterDiagnosis(encounter: EncounterRow, diagnosisId: number, session: Session):
  Promise<{ ok: true } | DiagnosisFailure> {
  const r = await sp6VoidDiagnosis(encounter.id, diagnosisId, session, new Date(), { asDoctor: true })
  if (!r.ok) return toWorkspaceError(r.error, r.issues)
  await invalidateCache(patientDetailCacheKey(encounter.patientId))
  return { ok: true }
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
