// Encounter coding writes (SP6 Task 7): coded diagnoses and procedures, the coding status
// actions, the rule-input loader and the coding gate SP4/SP7 read (ruling 2).
//
// LOCK ORDER (every write in this module and in coding-queries.ts):
//   1. the encounter's `encounter_coding` row, FOR UPDATE (lockEncounterCoding, created on
//      first use with INSERT … ON CONFLICT DO NOTHING), always first;
//   2. then the dependent row being changed (a diagnosis, procedure or coding query), FOR
//      UPDATE, by ascending id when more than one.
// Because every writer serialises on (1), a code edit and a status action on one encounter
// can never interleave: an edit racing `finalise` either lands before it (and the finalise
// then sees the reverted status and is refused) or after it (and is refused as `locked`).
//
// Each write is ONE transaction with its audit row (and coding event rows) inside it. A
// refused write rolls back entirely, so it leaves no lazily created coding row behind.
// Postgres 40P01/40001 propagate to the route, which maps them to 409 RETRY_MESSAGE.
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  codingQueries, diagnoses, encounterCoding, encounterCodingEvents, encounterProcedures, encounters, patients, providers,
  serviceCatalog, serviceProcedureCodes, users, type EncounterCodingRow, type EncounterRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Role, Session } from '@/lib/auth'
import type { CodeSystemKind } from '@/lib/coding/code-systems'
import type { CodingWriteError, CodingWriteResult } from '@/lib/coding/errors'
import { checkCodeForEntry, hasBlockingIssues, validateEncounterCoding, type CodingIssue, type CodingRuleInput, type Gender } from '@/lib/coding/rules'
import {
  doctorMayPropose, nextCodingStatus, statusAfterCoderEdit, type CodeEntryStatus, type EncounterCodingStatus,
} from '@/lib/coding/status'
import type {
  AddDiagnosisRequest, AddProcedureRequest, CodingStatusRequest, UpdateDiagnosisRequest, UpdateProcedureRequest,
} from '@/lib/coding/validation'
import { isUniqueViolation } from '@/lib/db-errors'
import { DEFAULT_TIMEZONE, istDateOf, todayIsoIn } from '@/lib/india-time'
import { getCodesByIds, type CodeDetail } from './code-systems'
import type { WriteExecutor } from './executor'

type Failure = { ok: false; error: CodingWriteError; issues?: CodingIssue[] }
const fail = (error: CodingWriteError, issues?: CodingIssue[]): Failure => (issues ? { ok: false, error, issues } : { ok: false, error })

// Thrown inside the transaction to roll back a refused write; never escapes this module.
class CodingRollback extends Error {
  constructor(readonly result: Failure) { super(result.error) }
}

/** Runs `fn` as one transaction; a not-ok result rolls everything back and is returned as-is. */
export async function runCodingTransaction<T>(fn: (tx: WriteExecutor) => Promise<CodingWriteResult<T>>): Promise<CodingWriteResult<T>> {
  try {
    return await getDb().transaction(async (tx) => {
      const r = await fn(tx)
      if (!r.ok) throw new CodingRollback(r)
      return r
    })
  } catch (err) {
    if (err instanceof CodingRollback) return err.result
    // Backstop for two primaries racing past the in-transaction check (cannot happen while
    // every writer holds the coding lock, but the partial unique index is the last word).
    if (isUniqueViolation(err, 'diagnoses_one_primary_per_encounter')) return fail('primary_exists')
    throw err
  }
}

export interface LockedEncounterCoding { coding: EncounterCodingRow; encounter: EncounterRow }

/**
 * Creates the encounter's coding row if missing, then locks it FOR UPDATE (only that row: the
 * joined encounter is read, not locked). Null when the encounter does not exist. MUST run
 * inside a transaction and MUST be the first lock the transaction takes.
 */
export async function lockEncounterCoding(tx: WriteExecutor, encounterId: number): Promise<LockedEncounterCoding | null> {
  const [enc] = await tx.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, encounterId))
  if (!enc) return null
  await tx.insert(encounterCoding).values({ encounterId, patientId: enc.patientId }).onConflictDoNothing({ target: encounterCoding.encounterId })
  const [row] = await tx
    .select({ coding: encounterCoding, encounter: encounters })
    .from(encounterCoding)
    .innerJoin(encounters, eq(encounters.id, encounterCoding.encounterId))
    .where(eq(encounterCoding.encounterId, encounterId))
    .for('update', { of: encounterCoding })
  return row ?? null
}

export type EntryActor = 'doctor' | 'coder'

/** pi proposes (doctor); coder and admin code (admin is exempt from the claim rule). */
export function actorFor(role: Role): EntryActor {
  return role === 'pi' ? 'doctor' : 'coder'
}

type Guarded = LockedEncounterCoding & { actor: EntryActor }

/** The shared write guard for diagnosis/procedure writes, in the order the rules are checked. */
async function guardEntryWrite(tx: WriteExecutor, encounterId: number, session: Session): Promise<CodingWriteResult<Guarded>> {
  const locked = await lockEncounterCoding(tx, encounterId)
  if (!locked) return fail('not_found')
  const { coding, encounter } = locked
  if (encounter.status === 'cancelled') return fail('encounter_cancelled')
  const actor = actorFor(session.role)
  if (actor === 'doctor') {
    if (!doctorMayPropose(coding.status)) return fail('locked')
  } else {
    if (encounter.status !== 'completed') return fail('encounter_not_completed')
    if (coding.status === 'finalised') return fail('locked')
    if (session.role === 'coder' && (session.userId === null || coding.assignedToUserId !== session.userId)) return fail('not_claimed')
  }
  return { ok: true, value: { ...locked, actor } }
}

/** After an entry write: a coder edit moves the status (coded → in_progress is an event). */
async function finishEntryWrite(tx: WriteExecutor, g: Guarded, session: Session, now: Date): Promise<void> {
  const from = g.coding.status
  const to = g.actor === 'coder' ? (statusAfterCoderEdit(from) ?? from) : from
  await tx.update(encounterCoding).set({ status: to, updatedAt: now }).where(eq(encounterCoding.encounterId, g.coding.encounterId))
  if (from === 'coded' && to === 'in_progress') {
    await tx.insert(encounterCodingEvents).values({
      encounterId: g.coding.encounterId, action: 'edit_after_coded', fromStatus: from, toStatus: to,
      reason: null, byName: session.name, byUserId: session.userId, at: now,
    })
  }
}

async function patientFacts(tx: WriteExecutor, patientId: string): Promise<{ gender: Gender | null; dob: string }> {
  const [p] = await tx.select({ gender: patients.gender, dob: patients.dob }).from(patients).where(eq(patients.id, patientId))
  return { gender: p.gender ?? null, dob: p.dob } // patients.id is an FK target: always present
}

/** Looks up a code and runs the write-time checks; errors refuse, warnings are returned. */
async function checkCode(
  tx: WriteExecutor, codeId: number, entryKind: 'diagnosis' | 'procedure', onDate: string, patientId: string,
): Promise<CodingWriteResult<{ code: CodeDetail; warnings: CodingIssue[] }>> {
  const code = (await getCodesByIds([codeId], tx)).get(codeId)
  if (!code) return fail('code_not_found')
  const issues = checkCodeForEntry(code, entryKind, { onDate, ...(await patientFacts(tx, patientId)) })
  if (hasBlockingIssues(issues)) return fail('code_invalid', issues.filter((i) => i.severity === 'error'))
  return { ok: true, value: { code, warnings: issues } }
}

const codeLabel = (kind: CodeSystemKind | null, code: string | null): string => (kind && code ? `${kind}:${code}` : 'none')

async function hasOtherLivePrimary(tx: WriteExecutor, encounterId: number, exceptId: number | null): Promise<boolean> {
  const rows = await tx.select({ id: diagnoses.id }).from(diagnoses).where(and(
    eq(diagnoses.encounterId, encounterId), eq(diagnoses.diagnosisType, 'primary'), isNull(diagnoses.voidedAt),
    exceptId === null ? undefined : ne(diagnoses.id, exceptId),
  )).limit(1)
  return rows.length > 0
}

// ---------------------------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------------------------

export async function addEncounterDiagnosis(
  encounterId: number, input: AddDiagnosisRequest, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ diagnosisId: number; warnings: CodingIssue[] }>> {
  return runCodingTransaction(async (tx) => {
    const g = await guardEntryWrite(tx, encounterId, session)
    if (!g.ok) return g
    const { encounter, actor } = g.value
    if (actor === 'coder' && input.codeId === undefined) return fail('code_required')
    let code: CodeDetail | null = null
    let warnings: CodingIssue[] = []
    if (input.codeId !== undefined) {
      const c = await checkCode(tx, input.codeId, 'diagnosis', encounter.encounterDate, encounter.patientId)
      if (!c.ok) return c
      ;({ code, warnings } = c.value)
    }
    if (input.type === 'primary' && await hasOtherLivePrimary(tx, encounterId, null)) return fail('primary_exists')
    const status: CodeEntryStatus = code === null ? 'uncoded' : actor === 'doctor' ? 'proposed' : 'coded'
    const [row] = await tx.insert(diagnoses).values({
      patientId: encounter.patientId,
      code: code?.code ?? '',
      description: input.description ?? code?.display ?? '',
      date: encounter.encounterDate,
      encounterId,
      codeId: code?.id ?? null,
      codeSystemKind: code?.kind ?? null,
      codeDisplay: code?.display ?? null,
      diagnosisType: input.type,
      codingStatus: status,
      sequence: input.sequence ?? null,
      proposedByName: status === 'proposed' ? session.name : null,
      proposedAt: status === 'proposed' ? now : null,
      codedByName: status === 'coded' ? session.name : null,
      codedAt: status === 'coded' ? now : null,
      createdByName: session.name,
      createdAt: now,
    }).returning({ id: diagnoses.id })
    await finishEntryWrite(tx, g.value, session, now)
    await logAudit(session, 'coding: added diagnosis', encounter.patientId,
      `encounter=${encounterId} diagnosis=${row.id} status=${status} type=${input.type} code=${codeLabel(code?.kind ?? null, code?.code ?? null)}`, tx)
    return { ok: true, value: { diagnosisId: row.id, warnings } }
  })
}

const diagnosisLockColumns = {
  id: diagnoses.id, encounterId: diagnoses.encounterId, voidedAt: diagnoses.voidedAt, codingStatus: diagnoses.codingStatus,
  diagnosisType: diagnoses.diagnosisType, codeSystemKind: diagnoses.codeSystemKind, code: diagnoses.code,
}

/** Locks a live diagnosis of this encounter (lock step 2); null when absent, voided or elsewhere. */
async function lockDiagnosis(tx: WriteExecutor, encounterId: number, diagnosisId: number) {
  const [row] = await tx.select(diagnosisLockColumns).from(diagnoses).where(eq(diagnoses.id, diagnosisId)).for('update')
  return row && row.encounterId === encounterId && row.voidedAt === null ? row : null
}

export async function updateEncounterDiagnosis(
  encounterId: number, diagnosisId: number, input: UpdateDiagnosisRequest, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ diagnosisId: number; warnings: CodingIssue[] }>> {
  return runCodingTransaction(async (tx) => {
    const g = await guardEntryWrite(tx, encounterId, session)
    if (!g.ok) return g
    const { encounter, actor } = g.value
    const row = await lockDiagnosis(tx, encounterId, diagnosisId)
    if (!row) return fail('entry_not_found')
    if (actor === 'doctor' && row.codingStatus === 'coded') return fail('locked')

    const type = input.type ?? row.diagnosisType
    if (type === 'primary' && row.diagnosisType !== 'primary' && await hasOtherLivePrimary(tx, encounterId, diagnosisId)) return fail('primary_exists')

    const patch: Partial<typeof diagnoses.$inferInsert> = {}
    if (input.type !== undefined) patch.diagnosisType = input.type
    if (input.sequence !== undefined) patch.sequence = input.sequence
    let warnings: CodingIssue[] = []
    let to = codeLabel(row.codeSystemKind, row.code)
    if (input.codeId !== undefined) {
      const c = await checkCode(tx, input.codeId, 'diagnosis', encounter.encounterDate, encounter.patientId)
      if (!c.ok) return c
      const { code } = c.value
      warnings = c.value.warnings
      Object.assign(patch, { codeId: code.id, codeSystemKind: code.kind, code: code.code, codeDisplay: code.display })
      if (actor === 'doctor') Object.assign(patch, { codingStatus: 'proposed', proposedByName: session.name, proposedAt: now })
      else Object.assign(patch, { codingStatus: 'coded', codedByName: session.name, codedAt: now })
      to = codeLabel(code.kind, code.code)
    }
    await tx.update(diagnoses).set(patch).where(eq(diagnoses.id, diagnosisId))
    await finishEntryWrite(tx, g.value, session, now)
    await logAudit(session, 'coding: changed diagnosis', encounter.patientId,
      `encounter=${encounterId} diagnosis=${diagnosisId} from=${codeLabel(row.codeSystemKind, row.code)} to=${to} type=${type ?? 'none'}`, tx)
    return { ok: true, value: { diagnosisId, warnings } }
  })
}

export async function voidEncounterDiagnosis(
  encounterId: number, diagnosisId: number, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ diagnosisId: number }>> {
  return runCodingTransaction(async (tx) => {
    const g = await guardEntryWrite(tx, encounterId, session)
    if (!g.ok) return g
    const row = await lockDiagnosis(tx, encounterId, diagnosisId)
    if (!row) return fail('entry_not_found')
    if (g.value.actor === 'doctor' && row.codingStatus === 'coded') return fail('locked')
    await tx.update(diagnoses).set({ voidedAt: now, voidedByName: session.name }).where(eq(diagnoses.id, diagnosisId))
    await finishEntryWrite(tx, g.value, session, now)
    await logAudit(session, 'coding: removed diagnosis', g.value.encounter.patientId,
      `encounter=${encounterId} diagnosis=${diagnosisId} code=${codeLabel(row.codeSystemKind, row.code)}`, tx)
    return { ok: true, value: { diagnosisId } }
  })
}

// ---------------------------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------------------------

/** Date, performing doctor and billed service checks shared by add and update. */
async function checkProcedureRefs(
  tx: WriteExecutor, i: { performedOn?: string; performedByProviderId?: number; serviceId?: number }, now: Date,
): Promise<Failure | null> {
  if (i.performedOn !== undefined && i.performedOn > todayIsoIn(DEFAULT_TIMEZONE, now)) return fail('performed_in_future')
  if (i.performedByProviderId !== undefined) {
    const [p] = await tx.select({ id: providers.id }).from(providers)
      .where(and(eq(providers.id, i.performedByProviderId), eq(providers.isActive, true)))
    if (!p) return fail('provider_not_found')
  }
  if (i.serviceId !== undefined) {
    const [s] = await tx.select({ id: serviceCatalog.id }).from(serviceCatalog).where(eq(serviceCatalog.id, i.serviceId))
    if (!s) return fail('service_not_found')
  }
  return null
}

export async function addEncounterProcedure(
  encounterId: number, input: AddProcedureRequest, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ procedureId: number; warnings: CodingIssue[] }>> {
  return runCodingTransaction(async (tx) => {
    const g = await guardEntryWrite(tx, encounterId, session)
    if (!g.ok) return g
    const { encounter, actor } = g.value
    if (actor === 'coder' && input.codeId === undefined) return fail('code_required')
    const refs = await checkProcedureRefs(tx, input, now)
    if (refs) return refs
    let code: CodeDetail | null = null
    let warnings: CodingIssue[] = []
    if (input.codeId !== undefined) {
      const c = await checkCode(tx, input.codeId, 'procedure', input.performedOn, encounter.patientId)
      if (!c.ok) return c
      ;({ code, warnings } = c.value)
    }
    const status: CodeEntryStatus = code === null ? 'uncoded' : actor === 'doctor' ? 'proposed' : 'coded'
    const [row] = await tx.insert(encounterProcedures).values({
      encounterId,
      patientId: encounter.patientId,
      description: input.description ?? code?.display ?? '',
      codeId: code?.id ?? null,
      codeSystemKind: code?.kind ?? null,
      code: code?.code ?? null,
      codeDisplay: code?.display ?? null,
      codingStatus: status,
      performedOn: input.performedOn,
      performedByProviderId: input.performedByProviderId ?? null,
      serviceId: input.serviceId ?? null,
      sequence: input.sequence ?? null,
      createdByName: session.name,
      createdAt: now,
      proposedByName: status === 'proposed' ? session.name : null,
      proposedAt: status === 'proposed' ? now : null,
      codedByName: status === 'coded' ? session.name : null,
      codedAt: status === 'coded' ? now : null,
    }).returning({ id: encounterProcedures.id })
    await finishEntryWrite(tx, g.value, session, now)
    await logAudit(session, 'coding: added procedure', encounter.patientId,
      `encounter=${encounterId} procedure=${row.id} status=${status} code=${codeLabel(code?.kind ?? null, code?.code ?? null)}`, tx)
    return { ok: true, value: { procedureId: row.id, warnings } }
  })
}

const procedureLockColumns = {
  id: encounterProcedures.id, encounterId: encounterProcedures.encounterId, voidedAt: encounterProcedures.voidedAt,
  codingStatus: encounterProcedures.codingStatus, codeId: encounterProcedures.codeId, codeSystemKind: encounterProcedures.codeSystemKind,
  code: encounterProcedures.code, performedOn: encounterProcedures.performedOn,
}

async function lockProcedure(tx: WriteExecutor, encounterId: number, procedureId: number) {
  const [row] = await tx.select(procedureLockColumns).from(encounterProcedures).where(eq(encounterProcedures.id, procedureId)).for('update')
  return row && row.encounterId === encounterId && row.voidedAt === null ? row : null
}

export async function updateEncounterProcedure(
  encounterId: number, procedureId: number, input: UpdateProcedureRequest, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ procedureId: number; warnings: CodingIssue[] }>> {
  return runCodingTransaction(async (tx) => {
    const g = await guardEntryWrite(tx, encounterId, session)
    if (!g.ok) return g
    const { encounter, actor } = g.value
    const row = await lockProcedure(tx, encounterId, procedureId)
    if (!row) return fail('entry_not_found')
    if (actor === 'doctor' && row.codingStatus === 'coded') return fail('locked')
    const refs = await checkProcedureRefs(tx, input, now)
    if (refs) return refs

    const patch: Partial<typeof encounterProcedures.$inferInsert> = {}
    if (input.description !== undefined) patch.description = input.description
    if (input.performedOn !== undefined) patch.performedOn = input.performedOn
    if (input.performedByProviderId !== undefined) patch.performedByProviderId = input.performedByProviderId
    if (input.serviceId !== undefined) patch.serviceId = input.serviceId
    if (input.sequence !== undefined) patch.sequence = input.sequence

    // Re-check the code whenever it or the date it is checked on changes.
    const effectiveCodeId = input.codeId ?? row.codeId
    let warnings: CodingIssue[] = []
    let to = codeLabel(row.codeSystemKind, row.code)
    if (effectiveCodeId !== null && (input.codeId !== undefined || input.performedOn !== undefined)) {
      const c = await checkCode(tx, effectiveCodeId, 'procedure', input.performedOn ?? row.performedOn, encounter.patientId)
      if (!c.ok) return c
      warnings = c.value.warnings
      if (input.codeId !== undefined) {
        const { code } = c.value
        Object.assign(patch, { codeId: code.id, codeSystemKind: code.kind, code: code.code, codeDisplay: code.display })
        if (actor === 'doctor') Object.assign(patch, { codingStatus: 'proposed', proposedByName: session.name, proposedAt: now })
        else Object.assign(patch, { codingStatus: 'coded', codedByName: session.name, codedAt: now })
        to = codeLabel(code.kind, code.code)
      }
    }
    await tx.update(encounterProcedures).set(patch).where(eq(encounterProcedures.id, procedureId))
    await finishEntryWrite(tx, g.value, session, now)
    await logAudit(session, 'coding: changed procedure', encounter.patientId,
      `encounter=${encounterId} procedure=${procedureId} from=${codeLabel(row.codeSystemKind, row.code)} to=${to}`, tx)
    return { ok: true, value: { procedureId, warnings } }
  })
}

export async function voidEncounterProcedure(
  encounterId: number, procedureId: number, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ procedureId: number }>> {
  return runCodingTransaction(async (tx) => {
    const g = await guardEntryWrite(tx, encounterId, session)
    if (!g.ok) return g
    const row = await lockProcedure(tx, encounterId, procedureId)
    if (!row) return fail('entry_not_found')
    if (g.value.actor === 'doctor' && row.codingStatus === 'coded') return fail('locked')
    await tx.update(encounterProcedures).set({ voidedAt: now, voidedByName: session.name }).where(eq(encounterProcedures.id, procedureId))
    await finishEntryWrite(tx, g.value, session, now)
    await logAudit(session, 'coding: removed procedure', g.value.encounter.patientId,
      `encounter=${encounterId} procedure=${procedureId} code=${codeLabel(row.codeSystemKind, row.code)}`, tx)
    return { ok: true, value: { procedureId } }
  })
}

// ---------------------------------------------------------------------------------------------
// Rule input, status actions, gate
// ---------------------------------------------------------------------------------------------

/** The pure rule engine's input for one encounter: live rows only. Null when no encounter. */
export async function loadCodingRuleInput(executor: WriteExecutor, encounterId: number): Promise<CodingRuleInput | null> {
  const [e] = await executor
    .select({ encounterDate: encounters.encounterDate, completedAt: encounters.completedAt, gender: patients.gender, dob: patients.dob })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .where(eq(encounters.id, encounterId))
  if (!e) return null
  const dx = await executor
    .select({ id: diagnoses.id, type: diagnoses.diagnosisType, codingStatus: diagnoses.codingStatus, codeId: diagnoses.codeId })
    .from(diagnoses)
    .where(and(eq(diagnoses.encounterId, encounterId), isNull(diagnoses.voidedAt)))
    .orderBy(asc(diagnoses.id))
  const procs = await executor
    .select({
      id: encounterProcedures.id, codingStatus: encounterProcedures.codingStatus, performedOn: encounterProcedures.performedOn,
      codeId: encounterProcedures.codeId, serviceId: encounterProcedures.serviceId,
    })
    .from(encounterProcedures)
    .where(and(eq(encounterProcedures.encounterId, encounterId), isNull(encounterProcedures.voidedAt)))
    .orderBy(asc(encounterProcedures.id))

  const codeIds = [...dx, ...procs].map((r) => r.codeId).filter((id): id is number => id !== null)
  const codeById = await getCodesByIds(codeIds, executor)
  const serviceIds = [...new Set(procs.map((p) => p.serviceId).filter((id): id is number => id !== null))]
  const mapped = new Map<number, { kind: CodeSystemKind; code: string }[]>()
  if (serviceIds.length) {
    const rows = await executor
      .select({ serviceId: serviceProcedureCodes.serviceId, kind: serviceProcedureCodes.codeSystemKind, code: serviceProcedureCodes.code })
      .from(serviceProcedureCodes)
      .where(inArray(serviceProcedureCodes.serviceId, serviceIds))
    for (const r of rows) mapped.set(r.serviceId, [...(mapped.get(r.serviceId) ?? []), { kind: r.kind, code: r.code }])
  }
  const ruleCode = (id: number | null) => (id === null ? null : codeById.get(id) ?? null)
  return {
    encounterDate: e.encounterDate,
    encounterEndDate: e.completedAt ? istDateOf(e.completedAt) : null,
    patient: { gender: e.gender ?? null, dob: e.dob },
    diagnoses: dx.map((d) => ({ id: d.id, type: d.type, codingStatus: d.codingStatus, code: ruleCode(d.codeId) })),
    procedures: procs.map((p) => ({
      id: p.id, codingStatus: p.codingStatus, performedOn: p.performedOn, code: ruleCode(p.codeId),
      serviceMappedCodes: p.serviceId === null ? null : mapped.get(p.serviceId) ?? null,
    })),
  }
}

/**
 * One coding status action (everything but raise_query, which is coding-queries.ts). Locks the
 * coding row, checks the status machine, applies the action, writes the event and the audit.
 * The reopen reason goes to the event row only, never the audit log.
 */
export async function applyCodingAction(
  encounterId: number, req: CodingStatusRequest, session: Session, now: Date = new Date(),
): Promise<CodingWriteResult<{ status: EncounterCodingStatus; issues: CodingIssue[] }>> {
  return runCodingTransaction(async (tx) => {
    const locked = await lockEncounterCoding(tx, encounterId)
    if (!locked) return fail('not_found')
    const { coding, encounter } = locked
    if (encounter.status === 'cancelled') return fail('encounter_cancelled')
    if (encounter.status !== 'completed') return fail('encounter_not_completed')
    const from = coding.status
    const to = nextCodingStatus(from, req.action)
    if (to === null) return fail('invalid_transition')

    // A coder acts only on an encounter they hold (ruling 7); admin is exempt.
    const lacksClaim = session.role === 'coder' && (session.userId === null || coding.assignedToUserId !== session.userId)
    const patch: Partial<typeof encounterCoding.$inferInsert> = { status: to, updatedAt: now }
    let issues: CodingIssue[] = []
    let assignee: number | null = null

    switch (req.action) {
      case 'claim': {
        if (session.userId === null) return fail('no_user_account')
        if (coding.assignedToUserId !== null && coding.assignedToUserId !== session.userId) return fail('already_assigned')
        Object.assign(patch, { assignedToUserId: session.userId, assignedToName: session.name, assignedAt: now })
        assignee = session.userId
        break
      }
      case 'assign': {
        const [u] = await tx.select({ id: users.id, name: users.name }).from(users)
          .where(and(eq(users.id, req.assigneeUserId), eq(users.role, 'coder')))
        if (!u) return fail('assignee_not_coder')
        Object.assign(patch, { assignedToUserId: u.id, assignedToName: u.name, assignedAt: now })
        assignee = u.id
        break
      }
      case 'release': {
        if (lacksClaim) return fail('not_claimed')
        Object.assign(patch, { assignedToUserId: null, assignedToName: null, assignedAt: null })
        break
      }
      case 'resume': {
        if (lacksClaim) return fail('not_claimed')
        const open = await tx.select({ id: codingQueries.id }).from(codingQueries)
          .where(and(eq(codingQueries.encounterId, encounterId), eq(codingQueries.status, 'open'))).limit(1)
        if (open.length) return fail('open_queries')
        break
      }
      case 'mark_coded':
      case 'finalise': {
        if (lacksClaim) return fail('not_claimed')
        const input = await loadCodingRuleInput(tx, encounterId)
        issues = validateEncounterCoding(input!, req.action === 'finalise' ? 'finalise' : 'coded')
        if (hasBlockingIssues(issues)) return fail('validation_failed', issues)
        if (req.action === 'finalise') Object.assign(patch, { finalisedAt: now, finalisedByName: session.name })
        else Object.assign(patch, { codedAt: now, codedByName: session.name })
        break
      }
      case 'reopen': {
        patch.reopenCount = coding.reopenCount + 1 // exact: the row is locked FOR UPDATE
        break
      }
    }

    await tx.update(encounterCoding).set(patch).where(eq(encounterCoding.encounterId, encounterId))
    await tx.insert(encounterCodingEvents).values({
      encounterId, action: req.action, fromStatus: from, toStatus: to,
      reason: req.action === 'reopen' ? req.reason : null,
      byName: session.name, byUserId: session.userId, at: now,
    })
    await logAudit(session, `coding: ${req.action}`, encounter.patientId,
      `encounter=${encounterId} from=${from} to=${to}${assignee !== null ? ` assignee=${assignee}` : ''}`, tx)
    return { ok: true, value: { status: to, issues } }
  })
}

/**
 * The encounter's coding status for SP4/SP7 (ruling 2): SP7 claim submission requires
 * `finalised`. No coding row reads `uncoded`; null when the encounter does not exist.
 */
export async function getEncounterCodingGate(
  encounterId: number, executor: WriteExecutor = getDb(),
): Promise<{ status: EncounterCodingStatus; finalised: boolean } | null> {
  const [r] = await executor
    .select({ id: encounters.id, status: encounterCoding.status })
    .from(encounters)
    .leftJoin(encounterCoding, eq(encounterCoding.encounterId, encounters.id))
    .where(eq(encounters.id, encounterId))
  if (!r) return null
  const status = r.status ?? 'uncoded'
  return { status, finalised: status === 'finalised' }
}
