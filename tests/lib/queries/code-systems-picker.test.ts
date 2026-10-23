// Picker rule: SAMPLE- versions are not offered once a licensed (non-sample) version exists, and
// are still offered when none exists. Fixtures are versions named TEST-S7-<run>… of kind hbp (a kind real data is rarely loaded for);
// the real current icd10 version is saved and restored around each test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq, inArray, like, or } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { codeSystems, codes } from '@/db/schema'
import { searchCodes } from '@/lib/queries/code-systems'

const RUN = `${Date.now()}`.slice(-7)
const LIC = `TEST-S7-${RUN}-L`
const SMP = `SAMPLE-TEST-S7-${RUN}-S`

describe.skipIf(!process.env.DATABASE_URL)('code picker prefers licensed over sample', () => {
  let saved: number[] = []
  let flipped: number[] = [] // pre-existing licensed hbp versions, treated as absent during the test
  beforeEach(async () => {
    const db = getDb()
    const cur = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'hbp'), eq(codeSystems.isCurrent, true)))
    saved = cur.map((c) => c.id)
    if (saved.length) await db.update(codeSystems).set({ isCurrent: false }).where(inArray(codeSystems.id, saved))
    const lic = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'hbp'), eq(codeSystems.isSample, false)))
    flipped = lic.map((l) => l.id)
    if (flipped.length) await db.update(codeSystems).set({ isSample: true }).where(inArray(codeSystems.id, flipped))
  })
  afterEach(async () => {
    const db = getDb()
    const mine = await db.select({ id: codeSystems.id }).from(codeSystems)
      .where(or(like(codeSystems.version, `TEST-S7-${RUN}-%`), like(codeSystems.version, `SAMPLE-TEST-S7-${RUN}-%`)))
    const ids = mine.map((m) => m.id)
    if (ids.length) {
      await db.delete(codes).where(inArray(codes.codeSystemId, ids))
      await db.delete(codeSystems).where(inArray(codeSystems.id, ids))
    }
    if (flipped.length) await db.update(codeSystems).set({ isSample: false }).where(inArray(codeSystems.id, flipped))
    if (saved.length) await db.update(codeSystems).set({ isCurrent: true }).where(inArray(codeSystems.id, saved))
  })

  async function load(version: string, isSample: boolean, isCurrent: boolean, display: string) {
    const db = getDb()
    const [cs] = await db.insert(codeSystems).values({
      kind: 'hbp', version, name: 'T', isSample, isCurrent, licenceNote: isSample ? null : 'test',
      sourceFileName: 't.csv', sourceSha256: 'x', codeCount: 1, importedByName: 'test',
    }).returning({ id: codeSystems.id })
    await db.insert(codes).values({ codeSystemId: cs.id, code: 'Z99', display, selectable: true, active: true, excludes: [] })
  }

  it('still offers a sample version when no licensed version exists', async () => {
    await load(SMP, true, true, 'SAMPLE fictional only')
    const r = await searchCodes({ kind: 'hbp', q: 'Z99', onDate: null, limit: 10 })
    expect(r.codeSystem?.isSample).toBe(true)
    expect(r.hits.map((h) => h.display)).toEqual(['SAMPLE fictional only'])
  })

  it('does not offer a sample version once a licensed one exists, even if the sample is flagged current', async () => {
    await load(LIC, false, false, 'Licensed')
    await load(SMP, true, true, 'SAMPLE fictional only')
    const r = await searchCodes({ kind: 'hbp', q: 'Z99', onDate: null, limit: 10 })
    expect(r.codeSystem?.isSample).toBe(false)
    expect(r.hits.map((h) => h.display)).toEqual(['Licensed'])
  })

  it('uses the licensed current version normally', async () => {
    await load(LIC, false, true, 'Licensed')
    await load(SMP, true, false, 'SAMPLE fictional only')
    const r = await searchCodes({ kind: 'hbp', q: 'Z99', onDate: null, limit: 10 })
    expect(r.hits.map((h) => h.display)).toEqual(['Licensed'])
  })
})
