// Code-system queries (SP6 Task 5) against the real local Postgres. Fixtures are versions named
// TEST-SP6-<run>… / SAMPLE-TEST-SP6-<run>… of kind icd10; they and their codes are deleted by id,
// and audit rows by this run's unique probe user name. The real current icd10 version (a
// developer's loaded code set, if any) is saved before each test and restored after it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, count, eq, inArray, like, or } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, codeSystems, codes } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { CodeImportRow } from '@/lib/coding/import'
import {
  CodeSystemVersionExistsError, SampleOverLicensedError, commitCodeSystemImport, findCurrentCode, findLoadedCodes,
  getCodesByIds, listCodeSystems, searchCodes, setCurrentCodeSystem, sha256Hex, type CommitCodeSystemInput,
} from '@/lib/queries/code-systems'

const RUN = `${Date.now()}`.slice(-7)
const PROBE_USER = `TEST-SP6-T5-${Date.now()}`
const SESSION: Session = { role: 'admin', name: PROBE_USER, userId: null }
const V = (s: string) => `TEST-SP6-${RUN}-${s}`
const SV = (s: string) => `SAMPLE-TEST-SP6-${RUN}-${s}`

const row = (code: string, over: Partial<CodeImportRow> = {}): CodeImportRow => ({
  code, display: `Test ${code}`, parentCode: null, selectable: true, active: true, effectiveFrom: null, effectiveTo: null,
  sexRestriction: null, ageMinYears: null, ageMaxYears: null, excludes: [], ...over,
})
const input = (version: string, over: Partial<CommitCodeSystemInput> = {}): CommitCodeSystemInput => ({
  kind: 'icd10', version, name: 'Test set', licenceNote: version.startsWith('SAMPLE-') ? null : 'Test licence',
  sourceFileName: 'test.csv', sourceSha256: sha256Hex(version), makeCurrent: false, isSample: version.startsWith('SAMPLE-'), ...over,
})

describe.skipIf(!process.env.DATABASE_URL)('code systems (DB)', () => {
  let savedCurrentId: number | null = null

  beforeEach(async () => {
    const db = getDb()
    const [cur] = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.isCurrent, true)))
    savedCurrentId = cur?.id ?? null
    if (savedCurrentId !== null) await db.update(codeSystems).set({ isCurrent: false }).where(eq(codeSystems.id, savedCurrentId))
  })

  afterEach(async () => {
    const db = getDb()
    const mine = await db.select({ id: codeSystems.id }).from(codeSystems)
      .where(or(like(codeSystems.version, `TEST-SP6-${RUN}-%`), like(codeSystems.version, `SAMPLE-TEST-SP6-${RUN}-%`)))
    const ids = mine.map((m) => m.id)
    if (ids.length) {
      await db.delete(codes).where(inArray(codes.codeSystemId, ids))
      await db.delete(codeSystems).where(inArray(codeSystems.id, ids))
    }
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    if (savedCurrentId !== null) await db.update(codeSystems).set({ isCurrent: true }).where(eq(codeSystems.id, savedCurrentId))
  })

  const systemByVersion = async (version: string) =>
    (await getDb().select().from(codeSystems).where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.version, version))))[0] ?? null
  const audits = async () => getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))

  it('imports all-or-nothing in one transaction with an audit row', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => row(`A00.${String(i).padStart(4, '0')}`))
    const r = await commitCodeSystemImport(input(V('big'), { makeCurrent: true }), rows, SESSION)
    expect(r.codeCount).toBe(2500)
    expect(r.isCurrent).toBe(true)
    const [{ n }] = await getDb().select({ n: count() }).from(codes).where(eq(codes.codeSystemId, r.codeSystemId))
    expect(n).toBe(2500)
    expect((await systemByVersion(V('big')))).toMatchObject({ codeCount: 2500, importedByName: PROBE_USER, licenceNote: 'Test licence', isSample: false })
    const a = await audits()
    expect(a.map((x) => x.action)).toEqual(['coding: imported code system'])
    expect(a[0].details).toBe(`kind=icd10 version=${V('big')} codes=2500 sample=false current=true`)
    expect(a[0].patientId).toBeNull()

    // A duplicate code injected past validation fails in the second chunk: nothing at all is kept.
    const dup = [...Array.from({ length: 1500 }, (_, i) => row(`B00.${String(i).padStart(4, '0')}`)), row('B00.0001')]
    await expect(commitCodeSystemImport(input(V('dup')), dup, SESSION)).rejects.toThrow()
    expect(await systemByVersion(V('dup'))).toBeNull()
    expect((await audits()).length).toBe(1)
  })

  it('refuses a second import of the same kind+version', async () => {
    await commitCodeSystemImport(input(V('same')), [row('C00')], SESSION)
    await expect(commitCodeSystemImport(input(V('same')), [row('C01')], SESSION)).rejects.toBeInstanceOf(CodeSystemVersionExistsError)
  })

  it('becomes current only when asked or when the kind has no current version', async () => {
    const first = await commitCodeSystemImport(input(V('first')), [row('D00')], SESSION)
    expect(first.isCurrent).toBe(true)
    const second = await commitCodeSystemImport(input(V('second')), [row('D00')], SESSION)
    expect(second.isCurrent).toBe(false)
    expect(await setCurrentCodeSystem(second.codeSystemId, SESSION)).toBe('ok')
    expect((await systemByVersion(V('first')))!.isCurrent).toBe(false)
    expect((await systemByVersion(V('second')))!.isCurrent).toBe(true)
    const a = (await audits()).filter((x) => x.action === 'coding: set current code system')
    expect(a.map((x) => x.details)).toEqual([`kind=icd10 version=${V('second')}`])
    expect(await setCurrentCodeSystem(2_000_000_000, SESSION)).toBe('not_found')

    const listed = (await listCodeSystems()).filter((c) => c.version.startsWith(`TEST-SP6-${RUN}-`))
    expect(listed.map((c) => c.version)).toEqual([V('second'), V('first')])
  })

  it('refuses to make a sample current over a licensed version', async () => {
    await commitCodeSystemImport(input(V('lic'), { makeCurrent: true }), [row('E00')], SESSION)
    await expect(commitCodeSystemImport(input(SV('a'), { makeCurrent: true }), [row('E00')], SESSION)).rejects.toBeInstanceOf(SampleOverLicensedError)
    expect(await systemByVersion(SV('a'))).toBeNull()
    const quiet = await commitCodeSystemImport(input(SV('b')), [row('E00')], SESSION)
    expect(quiet.isCurrent).toBe(false)
    expect(await setCurrentCodeSystem(quiet.codeSystemId, SESSION)).toBe('sample_over_licensed')
    expect((await systemByVersion(V('lic')))!.isCurrent).toBe(true)
  })

  it('a licensed import replaces a current sample, so a sample is never current beside a licensed set', async () => {
    // Other licensed icd10 versions may exist in a shared dev DB; this case needs none.
    const db = getDb()
    const licensed = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.isSample, false)))
    if (licensed.length > 0) return
    const sample = await commitCodeSystemImport(input(SV('cur')), [row('F00')], SESSION)
    expect(sample.isCurrent).toBe(true)
    const lic = await commitCodeSystemImport(input(V('after-sample')), [row('F00')], SESSION)
    expect(lic.isCurrent).toBe(true)
    expect((await systemByVersion(SV('cur')))!.isCurrent).toBe(false)
  })

  it('searches the current version by code prefix and display text, valid on a date', async () => {
    const r0 = await commitCodeSystemImport(input(V('search'), { makeCurrent: true }), [
      row('E11', { display: 'Type 2 diabetes group', selectable: false }),
      row('E11.9', { display: 'Type 2 diabetes without complications' }),
      row('E11.8', { display: 'Old entry', effectiveTo: '2020-12-31' }),
      row('X99.1', { display: 'Diabetic foot', active: false }),
      row('Z01', { display: 'Contains e11 in text' }),
    ], SESSION)
    const r = await searchCodes({ kind: 'icd10', q: 'e11', onDate: '2026-10-07', limit: 20 })
    expect(r.codeSystem).toEqual({ id: r0.codeSystemId, version: V('search'), isSample: false })
    expect(r.hits.map((h) => h.code)).toEqual(['E11', 'E11.9', 'Z01'])
    expect(r.hits[0]).toMatchObject({ kind: 'icd10', display: 'Type 2 diabetes group', selectable: false, version: V('search'), isSample: false })
    // Without a date, the expired E11.8 is back (active); selectable before code order among prefix matches.
    expect((await searchCodes({ kind: 'icd10', q: 'E11', onDate: null, limit: 20 })).hits.map((h) => h.code)).toEqual(['E11', 'E11.8', 'E11.9', 'Z01'])
    expect((await searchCodes({ kind: 'icd10', q: 'e11.', onDate: null, limit: 1 })).hits.map((h) => h.code)).toEqual(['E11.8'])
    expect((await searchCodes({ kind: 'icd10', q: 'diabetic', onDate: null, limit: 20 })).hits).toEqual([]) // inactive excluded
    expect((await searchCodes({ kind: 'icd10', q: '50%_', onDate: null, limit: 20 })).hits).toEqual([]) // LIKE metacharacters escaped
    expect((await searchCodes({ kind: 'icd10', q: '_', onDate: null, limit: 20 })).hits).toEqual([])
  })

  it('returns no code system and no hits when the kind has no current version', async () => {
    expect(await searchCodes({ kind: 'icd10', q: 'e11', onDate: null, limit: 20 })).toEqual({ codeSystem: null, hits: [] })
  })

  it('looks codes up by id, by current code, and as loaded non-sample bindings', async () => {
    const lic = await commitCodeSystemImport(input(V('look'), { makeCurrent: true }), [
      row('F10', { sexRestriction: 'male', ageMinYears: 18, excludes: ['F11'] }),
      row('F11', { active: false }),
    ], SESSION)
    const [f10] = await getDb().select().from(codes).where(and(eq(codes.codeSystemId, lic.codeSystemId), eq(codes.code, 'F10')))
    const byId = await getCodesByIds([f10.id, 2_000_000_000])
    expect(byId.size).toBe(1)
    expect(byId.get(f10.id)).toEqual({
      id: f10.id, kind: 'icd10', code: 'F10', active: true, effectiveFrom: null, effectiveTo: null, selectable: true,
      sexRestriction: 'male', ageMinYears: 18, ageMaxYears: null, excludes: ['F11'], display: 'Test F10',
      version: V('look'), isSample: false, codeSystemId: lic.codeSystemId,
    })
    expect(await getCodesByIds([])).toEqual(new Map())
    expect((await findCurrentCode('icd10', ' f10 '))?.id).toBe(f10.id)
    expect(await findCurrentCode('icd10', 'NOPE')).toBeNull()

    const loaded = await findLoadedCodes('icd10', ['F10', 'F11', 'G00'])
    expect([...loaded.entries()]).toEqual([['F10', { kind: 'icd10', version: V('look'), isSample: false }]])

    // A current sample set never yields loaded bindings.
    await getDb().update(codeSystems).set({ isCurrent: false }).where(eq(codeSystems.id, lic.codeSystemId))
    const s = await commitCodeSystemImport(input(SV('look')), [row('F10')], SESSION)
    await getDb().update(codeSystems).set({ isCurrent: true }).where(eq(codeSystems.id, s.codeSystemId))
    expect((await findLoadedCodes('icd10', ['F10'])).size).toBe(0)
  })
})
