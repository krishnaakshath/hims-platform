import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import {
  codeSystems, codes, encounterProcedures, encounterCoding, encounterCodingEvents, codingQueries, codingQueryResponses,
  serviceProcedureCodes, diagnoses, encounters,
  codeSystemKindEnum, codeEntryStatusEnum, diagnosisTypeEnum, encounterCodingStatusEnum, codingEventActionEnum, codingQueryStatusEnum,
} from '@/db/schema'
import { CODE_SYSTEM_KINDS } from '@/lib/coding/code-systems'
import {
  CODE_ENTRY_STATUSES, CODING_EVENT_ACTIONS, CODING_QUERY_STATUSES, DIAGNOSIS_TYPES, ENCOUNTER_CODING_STATUSES,
} from '@/lib/coding/status'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-07-sp6-b-clinical-coding.sql'
const NEW_TABLES = [codeSystems, codes, encounterProcedures, encounterCoding, encounterCodingEvents, codingQueries, codingQueryResponses, serviceProcedureCodes]
const SP6_DIAGNOSIS_COLUMNS = ['encounter_id', 'code_id', 'code_system_kind', 'code_display', 'diagnosis_type', 'coding_status', 'sequence', 'proposed_by_name', 'proposed_at', 'coded_by_name', 'coded_at', 'voided_at', 'voided_by_name', 'created_by_name', 'created_at']
const SP6_ENUMS = [codeSystemKindEnum, codeEntryStatusEnum, diagnosisTypeEnum, encounterCodingStatusEnum, codingEventActionEnum, codingQueryStatusEnum]

function constraintNames(t: PgTable): string[] {
  const c = getTableConfig(t)
  return [
    ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
    ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!),
  ]
}

describe('SP6 clinical coding schema', () => {
  it('migration is idempotent and non-destructive, with no data updates', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(s).not.toMatch(/\bUPDATE\s+diagnoses\b/i)
    expect(s).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i)
    expect(s).not.toMatch(/\bDELETE\s+FROM\b/i)
  })

  it.each(NEW_TABLES.map((t) => [getTableConfig(t).name, t] as const))('declares every %s column', (_n, t) => {
    expect(missingColumns(t, readMigration(MIGRATION))).toEqual([])
  })

  it('declares the SP6 diagnosis columns, and diagnoses keeps its legacy columns untouched', () => {
    const s = readMigration(MIGRATION)
    expect(missingColumns(diagnoses, s).filter((c) => SP6_DIAGNOSIS_COLUMNS.includes(c))).toEqual([])
    for (const c of SP6_DIAGNOSIS_COLUMNS) expect(s, c).toMatch(new RegExp(`ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS ${c}\\b`))
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS coding_status code_entry_status NOT NULL DEFAULT 'uncoded'/)
    // The legacy NOT NULL `code`/`description` columns are never altered.
    expect(s).not.toMatch(/ALTER COLUMN/i)
    const legacy = getTableConfig(diagnoses).columns.filter((c) => !SP6_DIAGNOSIS_COLUMNS.includes(c.name)).map((c) => c.name)
    expect(legacy.sort()).toEqual(['code', 'date', 'description', 'id', 'patient_id'])
  })

  it('every FK, unique, check and index name is in the SQL and fits 63 chars', () => {
    const s = readMigration(MIGRATION)
    for (const t of NEW_TABLES) {
      const names = constraintNames(t)
      expect(names.length).toBeGreaterThan(0)
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        expect(s, n).toContain(n)
      }
    }
    // diagnoses: only the SP6 additions (the legacy patient FK predates this migration).
    const diagNames = constraintNames(diagnoses).filter((n) => n !== 'diagnoses_patient_id_patients_id_fk')
    expect(diagNames.sort()).toEqual([
      'diagnoses_code_id_codes_id_fk', 'diagnoses_code_kind_pair', 'diagnoses_coded_complete', 'diagnoses_encounter_id_encounters_id_fk',
      'diagnoses_encounter_id_idx', 'diagnoses_one_primary_per_encounter', 'diagnoses_proposed_has_code',
    ])
    for (const n of diagNames) {
      expect(n.length, n).toBeLessThanOrEqual(63)
      expect(s, n).toContain(n)
    }
  })

  it('declares the ON DELETE behaviour of each FK in the migration', () => {
    const s = readMigration(MIGRATION)
    for (const t of [...NEW_TABLES, diagnoses]) {
      for (const fk of getTableConfig(t).foreignKeys) {
        const name = fk.getName()
        if (name === 'diagnoses_patient_id_patients_id_fk') continue
        const at = s.indexOf(`ADD CONSTRAINT ${name}`)
        expect(at, name).toBeGreaterThan(-1)
        const stmt = s.slice(at, s.indexOf(';', at))
        const expected = fk.onDelete === 'set null' ? /ON DELETE SET NULL/ : fk.onDelete === 'cascade' ? /ON DELETE CASCADE/ : /^(?![\s\S]*ON DELETE)/
        expect(stmt, name).toMatch(expected)
      }
    }
    const responsesFk = getTableConfig(codingQueryResponses).foreignKeys[0]
    expect(responsesFk.getName()).toBe('coding_query_responses_query_fk')
    expect(responsesFk.onDelete).toBe('cascade')
  })

  it('partial unique indexes carry their WHERE clause in the migration', () => {
    const s = readMigration(MIGRATION)
    expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS code_systems_one_current_per_kind ON code_systems \(kind\) WHERE is_current;/)
    expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS diagnoses_one_primary_per_encounter ON diagnoses \(encounter_id\) WHERE diagnosis_type = 'primary' AND voided_at IS NULL;/)
    expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS service_procedure_codes_one_primary ON service_procedure_codes \(service_id\) WHERE is_primary;/)
    expect(s).toMatch(/CREATE INDEX IF NOT EXISTS codes_code_prefix_idx ON codes \(code_system_id, code text_pattern_ops\);/)
  })

  it('pgEnum values match the pure constants', () => {
    expect(codeSystemKindEnum.enumValues).toEqual([...CODE_SYSTEM_KINDS])
    expect(encounterCodingStatusEnum.enumValues).toEqual([...ENCOUNTER_CODING_STATUSES])
    expect(codeEntryStatusEnum.enumValues).toEqual([...CODE_ENTRY_STATUSES])
    expect(diagnosisTypeEnum.enumValues).toEqual([...DIAGNOSIS_TYPES])
    expect(codingEventActionEnum.enumValues).toEqual([...CODING_EVENT_ACTIONS])
    expect(codingQueryStatusEnum.enumValues).toEqual([...CODING_QUERY_STATUSES])
  })

  it('migration creates each enum type with every value', () => {
    const s = readMigration(MIGRATION)
    for (const e of SP6_ENUMS) {
      const values = e.enumValues.map((v) => `'${v}'`).join(', ')
      expect(s, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${values});`)
    }
  })

  it('the trigram index and extension are in the migration only', () => {
    const s = readMigration(MIGRATION)
    expect(s).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/)
    expect(s).toMatch(/codes_display_trgm_idx[\s\S]*gin_trgm_ops/)
    expect(constraintNames(codes)).not.toContain('codes_display_trgm_idx')
  })

  it('deletePatient and clearExistingData clear the coding tables before encounters', () => {
    const del = readFileSync(join(process.cwd(), 'src/lib/queries/patients.ts'), 'utf8')
    const enc = del.indexOf('await db.delete(encounters).where')
    expect(enc).toBeGreaterThan(-1)
    for (const t of ['codingQueries', 'encounterCodingEvents', 'encounterCoding', 'encounterProcedures', 'diagnoses']) {
      const at = del.indexOf(`db.delete(${t})`)
      expect(at, t).toBeGreaterThan(-1)
      expect(at, t).toBeLessThan(enc)
    }
    const seed = readFileSync(join(process.cwd(), 'src/db/seed.ts'), 'utf8')
    const seedEnc = seed.indexOf('await db.delete(encounters)')
    for (const t of ['codingQueryResponses', 'codingQueries', 'encounterCodingEvents', 'encounterCoding', 'encounterProcedures', 'diagnoses']) {
      const at = seed.indexOf(`await db.delete(${t})`)
      expect(at, t).toBeGreaterThan(-1)
      expect(at, t).toBeLessThan(seedEnc)
    }
    expect(seed.indexOf('await db.delete(serviceProcedureCodes)')).toBeGreaterThan(-1)
    expect(seed.indexOf('await db.delete(serviceProcedureCodes)')).toBeLessThan(seed.indexOf('await db.delete(tariffRates)'))
    // Code systems are owner-loaded reference data: the seed never clears them.
    expect(seed).not.toMatch(/db\.delete\(codeSystems\)|db\.delete\(codes\)/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('SP6 schema (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP6-${RUN}`
  let providerId = 0
  const ids = { responses: [] as number[], queries: [] as number[], diagnoses: [] as number[], codes: [] as number[], systems: [] as number[], encounters: [] as number[] }

  async function errorOf(p: Promise<unknown>): Promise<unknown> {
    try { await p } catch (e) { return e }
    return undefined
  }

  beforeEach(async () => {
    const { getDb } = await import('@/db/client')
    const { patients, providers } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).orderBy(providers.id).limit(1)
    providerId = p.id
    await db.insert(patients).values({ id: PID, name: 'Test SP6 Schema', dob: '1990-01-01' })
  })

  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { patients } = await import('@/db/schema')
    const { eq, inArray } = await import('drizzle-orm')
    const db = getDb()
    // Children first (plan Global Constraints order), each by the ids this test created.
    if (ids.responses.length) await db.delete(codingQueryResponses).where(inArray(codingQueryResponses.id, ids.responses.splice(0)))
    if (ids.queries.length) await db.delete(codingQueries).where(inArray(codingQueries.id, ids.queries.splice(0)))
    if (ids.diagnoses.length) await db.delete(diagnoses).where(inArray(diagnoses.id, ids.diagnoses.splice(0)))
    if (ids.codes.length) await db.delete(codes).where(inArray(codes.id, ids.codes.splice(0)))
    if (ids.systems.length) await db.delete(codeSystems).where(inArray(codeSystems.id, ids.systems.splice(0)))
    if (ids.encounters.length) await db.delete(encounters).where(inArray(encounters.id, ids.encounters.splice(0)))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  async function insertEncounter() {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(encounters).values({
      patientId: PID, encounterType: 'opd', encounterDate: '2099-01-01', providerId, checkedInByName: 'TEST-SP6',
    }).returning()
    ids.encounters.push(r.id)
    return r
  }

  async function insertDiagnosis(v: Partial<typeof diagnoses.$inferInsert>) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(diagnoses).values({ patientId: PID, code: '', description: 'TEST-SP6', ...v }).returning()
    ids.diagnoses.push(r.id)
    return r
  }

  async function insertSystem(v: Partial<typeof codeSystems.$inferInsert>) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(codeSystems).values({
      kind: 'icd10', version: `TEST-SP6-${RUN}`, name: 'TEST-SP6', isSample: true, sourceFileName: 'test.csv',
      sourceSha256: '0'.repeat(64), codeCount: 1, importedByName: 'TEST-SP6', ...v,
    }).returning()
    ids.systems.push(r.id)
    return r
  }

  it('migration leaves a legacy diagnosis untouched and uncoded', async () => {
    const row = await insertDiagnosis({ code: 'F32.1', description: 'Depression', date: '2025-01-15' })
    expect(row.code).toBe('F32.1')
    expect(row.description).toBe('Depression')
    expect(row.date).toBe('2025-01-15')
    expect(row.codingStatus).toBe('uncoded')
    expect(row.encounterId).toBeNull()
    expect(row.codeId).toBeNull()
    expect(row.codeSystemKind).toBeNull()
    expect(row.diagnosisType).toBeNull()
    expect(row.createdAt).toBeNull()
  })

  it('allows one live primary per encounter', async () => {
    const { isUniqueViolation } = await import('@/lib/db-errors')
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    const enc = await insertEncounter()
    const first = await insertDiagnosis({ encounterId: enc.id, diagnosisType: 'primary' })
    const err = await errorOf(insertDiagnosis({ encounterId: enc.id, diagnosisType: 'primary' }))
    expect(isUniqueViolation(err, 'diagnoses_one_primary_per_encounter')).toBe(true)
    await insertDiagnosis({ encounterId: enc.id, diagnosisType: 'secondary' })
    await getDb().update(diagnoses).set({ voidedAt: new Date(), voidedByName: 'TEST-SP6' }).where(eq(diagnoses.id, first.id))
    const second = await insertDiagnosis({ encounterId: enc.id, diagnosisType: 'primary' })
    expect(second.diagnosisType).toBe('primary')
  })

  it('refuses a coded diagnosis without a code, a proposed one without a code, and an unpaired code kind', async () => {
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const enc = await insertEncounter()
    const coded = await errorOf(insertDiagnosis({ encounterId: enc.id, diagnosisType: 'secondary', codingStatus: 'coded' }))
    expect(pgErrorCode(coded)).toBe('23514')
    expect(pgConstraint(coded)).toBe('diagnoses_coded_complete')
    expect(pgConstraint(await errorOf(insertDiagnosis({ encounterId: enc.id, codingStatus: 'proposed' })))).toBe('diagnoses_proposed_has_code')
    expect(pgConstraint(await errorOf(insertDiagnosis({ encounterId: enc.id, codeSystemKind: 'icd10' })))).toBe('diagnoses_code_kind_pair')
    // A complete coded row is accepted.
    const sys = await insertSystem({})
    const { getDb } = await import('@/db/client')
    const [code] = await getDb().insert(codes).values({ codeSystemId: sys.id, code: 'X00.0', display: 'SAMPLE fictional TEST-SP6' }).returning()
    ids.codes.push(code.id)
    expect(code.excludes).toEqual([])
    const ok = await insertDiagnosis({ encounterId: enc.id, diagnosisType: 'secondary', codingStatus: 'coded', codeId: code.id, codeSystemKind: 'icd10', code: 'X00.0' })
    expect(ok.codingStatus).toBe('coded')
  })

  it('allows one current version per kind and cascades query responses', async () => {
    const { isUniqueViolation } = await import('@/lib/db-errors')
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    // Pick a kind with no current version so a real loaded set never collides with this fixture.
    const current = new Set((await db.select({ kind: codeSystems.kind }).from(codeSystems).where(eq(codeSystems.isCurrent, true))).map((r) => r.kind))
    const kind = CODE_SYSTEM_KINDS.find((k) => !current.has(k))!
    await insertSystem({ kind, version: `TEST-SP6-${RUN}-a`, isCurrent: true })
    const err = await errorOf(insertSystem({ kind, version: `TEST-SP6-${RUN}-b`, isCurrent: true }))
    expect(isUniqueViolation(err, 'code_systems_one_current_per_kind')).toBe(true)
    // A licensed version needs a licence note.
    const { pgConstraint } = await import('@/lib/db-errors')
    expect(pgConstraint(await errorOf(insertSystem({ kind, version: `TEST-SP6-${RUN}-c`, isSample: false })))).toBe('code_systems_licence_unless_sample')

    const enc = await insertEncounter()
    const [q] = await db.insert(codingQueries).values({
      encounterId: enc.id, patientId: PID, addressedToProviderId: providerId, question: 'TEST-SP6 question', raisedByName: 'TEST-SP6',
    }).returning()
    ids.queries.push(q.id)
    expect(q.status).toBe('open')
    const [r] = await db.insert(codingQueryResponses).values({ queryId: q.id, authorName: 'TEST-SP6', authorRole: 'pi', body: 'TEST-SP6 reply' }).returning()
    ids.responses.push(r.id)
    await db.delete(codingQueries).where(eq(codingQueries.id, q.id))
    ids.queries.splice(0)
    expect(await db.select().from(codingQueryResponses).where(eq(codingQueryResponses.id, r.id))).toEqual([])
    ids.responses.splice(0)
  })

  it('the trigram index exists on codes after the migration', async () => {
    const { getDb } = await import('@/db/client')
    const { sql } = await import('drizzle-orm')
    const res = await getDb().execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'codes_display_trgm_idx'`)
    expect(res.rows[0]?.indexdef).toMatch(/gin_trgm_ops/)
  })
})
