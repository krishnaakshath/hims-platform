// SP6 code-system query layer: import commit, version list, set current, code search and the code
// lookups the coding writes (Task 7), the service map (Task 14) and FHIR (Task 15) build on.
//
// Rules enforced here (plan rulings 1, 9, 10, 13):
// - A version is never updated in place or deleted; an import is ONE transaction (code_systems row,
//   every code in chunks, audit row), so a failure anywhere keeps nothing.
// - Writes for a kind serialise on `pg_advisory_xact_lock(hashtext('code_systems:' || kind))`, so the
//   version-exists and current-version checks cannot race another import or set-current.
// - At most one current version per kind (the partial unique index backs this up). A SAMPLE set
//   never becomes current while a licensed (non-sample) version of the kind is loaded.
// - Audit details carry kind, version, counts and flags only; never file contents.
// - DB errors propagate unchanged; routes and the CLI map them.
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { codeSystems, codes, type CodeSystemRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isSampleVersion, normalizeCode, type CodeBinding, type CodeSystemKind } from '@/lib/coding/code-systems'
import type { CodeImportMeta, CodeImportRow } from '@/lib/coding/import'
import type { RuleCode } from '@/lib/coding/rules'
import type { WriteExecutor } from '@/lib/queries/executor'

type Db = ReturnType<typeof getDb>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export class CodeSystemVersionExistsError extends Error {
  constructor() {
    super('That version of this code set is already loaded')
    this.name = 'CodeSystemVersionExistsError'
  }
}

export class SampleOverLicensedError extends Error {
  constructor() {
    super('A sample code set cannot replace a licensed one')
    this.name = 'SampleOverLicensedError'
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface CommitCodeSystemInput extends CodeImportMeta {
  sourceFileName: string
  sourceSha256: string
  makeCurrent: boolean
  isSample: boolean
}

const CODE_INSERT_CHUNK = 1000

async function lockKind(tx: Tx, kind: CodeSystemKind): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`code_systems:${kind}`}))`)
}

async function hasLicensedVersion(tx: Tx, kind: CodeSystemKind): Promise<boolean> {
  const [r] = await tx.select({ id: codeSystems.id }).from(codeSystems)
    .where(and(eq(codeSystems.kind, kind), eq(codeSystems.isSample, false))).limit(1)
  return r !== undefined
}

/** Commits a validated import (callers run validateCodeSystemImport first and pass only clean rows). */
export async function commitCodeSystemImport(
  input: CommitCodeSystemInput,
  rows: CodeImportRow[],
  session: Session,
): Promise<{ codeSystemId: number; codeCount: number; isCurrent: boolean }> {
  const isSample = input.isSample || isSampleVersion(input.version)
  return getDb().transaction(async (tx) => {
    await lockKind(tx, input.kind)
    const [existing] = await tx.select({ id: codeSystems.id }).from(codeSystems)
      .where(and(eq(codeSystems.kind, input.kind), eq(codeSystems.version, input.version))).limit(1)
    if (existing) throw new CodeSystemVersionExistsError()

    const [current] = await tx.select({ id: codeSystems.id }).from(codeSystems)
      .where(and(eq(codeSystems.kind, input.kind), eq(codeSystems.isCurrent, true))).limit(1)
    let isCurrent: boolean
    if (isSample && await hasLicensedVersion(tx, input.kind)) {
      if (input.makeCurrent) throw new SampleOverLicensedError()
      isCurrent = false
    } else {
      isCurrent = input.makeCurrent || current === undefined
    }
    if (isCurrent && current) {
      await tx.update(codeSystems).set({ isCurrent: false }).where(eq(codeSystems.id, current.id))
    }

    const note = input.licenceNote?.trim() ?? ''
    const [created] = await tx.insert(codeSystems).values({
      kind: input.kind,
      version: input.version,
      name: input.name.trim(),
      isSample,
      isCurrent,
      licenceNote: note === '' ? null : note,
      sourceFileName: input.sourceFileName,
      sourceSha256: input.sourceSha256,
      codeCount: rows.length,
      importedByName: session.name,
    }).returning({ id: codeSystems.id })

    for (let i = 0; i < rows.length; i += CODE_INSERT_CHUNK) {
      await tx.insert(codes).values(rows.slice(i, i + CODE_INSERT_CHUNK).map((r) => ({
        codeSystemId: created.id,
        code: r.code,
        display: r.display,
        parentCode: r.parentCode,
        selectable: r.selectable,
        active: r.active,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        sexRestriction: r.sexRestriction,
        ageMinYears: r.ageMinYears,
        ageMaxYears: r.ageMaxYears,
        excludes: r.excludes,
      })))
    }

    await logAudit(
      session, 'coding: imported code system', null,
      `kind=${input.kind} version=${input.version} codes=${rows.length} sample=${isSample} current=${isCurrent}`, tx,
    )
    return { codeSystemId: created.id, codeCount: rows.length, isCurrent }
  })
}

/** Every loaded version, by kind, newest first. */
export async function listCodeSystems(): Promise<CodeSystemRow[]> {
  return getDb().select().from(codeSystems).orderBy(asc(codeSystems.kind), desc(codeSystems.importedAt), desc(codeSystems.id))
}

export async function setCurrentCodeSystem(id: number, session: Session): Promise<'ok' | 'not_found' | 'sample_over_licensed'> {
  return getDb().transaction(async (tx) => {
    const [found] = await tx.select({ kind: codeSystems.kind }).from(codeSystems).where(eq(codeSystems.id, id))
    if (!found) return 'not_found'
    await lockKind(tx, found.kind)
    const [row] = await tx.select().from(codeSystems).where(eq(codeSystems.id, id))
    if (!row) return 'not_found'
    if (row.isSample && await hasLicensedVersion(tx, row.kind)) return 'sample_over_licensed'
    await tx.update(codeSystems).set({ isCurrent: false })
      .where(and(eq(codeSystems.kind, row.kind), eq(codeSystems.isCurrent, true)))
    await tx.update(codeSystems).set({ isCurrent: true }).where(eq(codeSystems.id, id))
    await logAudit(session, 'coding: set current code system', null, `kind=${row.kind} version=${row.version}`, tx)
    return 'ok'
  })
}

export interface CodeSearchHit {
  id: number
  kind: CodeSystemKind
  code: string
  display: string
  selectable: boolean
  version: string
  isSample: boolean
}

/** Escapes LIKE metacharacters for use with `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function validOn(onDate: string): SQL {
  return sql`(${codes.effectiveFrom} IS NULL OR ${codes.effectiveFrom} <= ${onDate}) AND (${codes.effectiveTo} IS NULL OR ${codes.effectiveTo} >= ${onDate})`
}

/** Prefix/text search over the kind's CURRENT version: active codes only, valid on `onDate` when given. */
export async function searchCodes(i: { kind: CodeSystemKind; q: string; onDate: string | null; limit: number }): Promise<{
  codeSystem: { id: number; version: string; isSample: boolean } | null
  hits: CodeSearchHit[]
}> {
  const db = getDb()
  const [cs] = await db.select({ id: codeSystems.id, version: codeSystems.version, isSample: codeSystems.isSample })
    .from(codeSystems).where(and(eq(codeSystems.kind, i.kind), eq(codeSystems.isCurrent, true))).limit(1)
  if (!cs) return { codeSystem: null, hits: [] }

  const exact = normalizeCode(i.q)
  const prefix = `${escapeLike(exact)}%`
  const text = `%${escapeLike(i.q.trim().toLowerCase())}%`
  const isPrefix = sql`${codes.code} LIKE ${prefix} ESCAPE '\\'`
  const conditions: SQL[] = [
    eq(codes.codeSystemId, cs.id),
    eq(codes.active, true),
    sql`(${isPrefix} OR lower(${codes.display}) LIKE ${text} ESCAPE '\\')`,
  ]
  if (i.onDate !== null) conditions.push(validOn(i.onDate))
  const rows = await db.select({ id: codes.id, code: codes.code, display: codes.display, selectable: codes.selectable })
    .from(codes).where(and(...conditions))
    .orderBy(
      sql`(${codes.code} = ${exact}) DESC`,
      sql`(${isPrefix}) DESC`,
      desc(codes.selectable),
      asc(codes.code),
    )
    .limit(i.limit)
  return {
    codeSystem: cs,
    hits: rows.map((r) => ({ ...r, kind: i.kind, version: cs.version, isSample: cs.isSample })),
  }
}

export type CodeDetail = RuleCode & { display: string; version: string; isSample: boolean; codeSystemId: number }

const detailColumns = {
  id: codes.id,
  kind: codeSystems.kind,
  code: codes.code,
  active: codes.active,
  effectiveFrom: codes.effectiveFrom,
  effectiveTo: codes.effectiveTo,
  selectable: codes.selectable,
  sexRestriction: codes.sexRestriction,
  ageMinYears: codes.ageMinYears,
  ageMaxYears: codes.ageMaxYears,
  excludes: codes.excludes,
  display: codes.display,
  version: codeSystems.version,
  isSample: codeSystems.isSample,
  codeSystemId: codes.codeSystemId,
}

/** Codes by id (any version, current or not), keyed by id; unknown ids are absent. */
export async function getCodesByIds(ids: number[], executor: WriteExecutor = getDb()): Promise<Map<number, CodeDetail>> {
  const out = new Map<number, CodeDetail>()
  if (ids.length === 0) return out
  const rows = await executor.select(detailColumns).from(codes)
    .innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(inArray(codes.id, [...new Set(ids)]))
  for (const r of rows) out.set(r.id, r)
  return out
}

/** The code in the kind's current version (any status), or null. */
export async function findCurrentCode(kind: CodeSystemKind, code: string, executor: WriteExecutor = getDb()): Promise<CodeDetail | null> {
  const [r] = await executor.select(detailColumns).from(codes)
    .innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(and(eq(codeSystems.kind, kind), eq(codeSystems.isCurrent, true), eq(codes.code, normalizeCode(code))))
    .limit(1)
  return r ?? null
}

/** FHIR bindings for codes present, active, in the kind's current NON-sample version; keyed by code. */
export async function findLoadedCodes(kind: CodeSystemKind, codeValues: string[]): Promise<Map<string, CodeBinding>> {
  const out = new Map<string, CodeBinding>()
  const wanted = [...new Set(codeValues.map(normalizeCode).filter((c) => c !== ''))]
  if (wanted.length === 0) return out
  const rows = await getDb().select({ code: codes.code, version: codeSystems.version }).from(codes)
    .innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(and(
      eq(codeSystems.kind, kind), eq(codeSystems.isCurrent, true), eq(codeSystems.isSample, false),
      eq(codes.active, true), inArray(codes.code, wanted),
    ))
  for (const r of rows) out.set(r.code, { kind, version: r.version, isSample: false })
  return out
}
