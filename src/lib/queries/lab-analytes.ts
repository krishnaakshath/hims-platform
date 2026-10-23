// WS4 T8 (spec 3.3 items 17, 21): each lab test's analytes and their age/sex reference ranges.
// Edited from Settings → Lab setup (LAB_SETUP_ROLES); read by result entry. One transaction per
// replace with its audit row on the same `tx`; audit details carry ids and a count only.
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { labAnalyteRanges, labResultValues, labTestAnalytes, labTests, type LabAnalyteRangeRow, type LabTestAnalyteRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { AnalyteDef, AnalyteRange } from '@/lib/labs/analytes'
import type { AnalyteDefinitionInput } from '@/lib/labs/validation'
import type { WriteExecutor } from '@/lib/queries/executor'

/** An analyte as stored: the pure definition plus what the setup editor round-trips. */
export interface AnalyteRecord extends AnalyteDef { loincCode: string | null; isActive: boolean }

function toRange(r: LabAnalyteRangeRow): AnalyteRange {
  return {
    sex: r.sex, ageMinDays: r.ageMinDays, ageMaxDays: r.ageMaxDays, normalLow: r.normalLow, normalHigh: r.normalHigh,
    criticalLow: r.criticalLow, criticalHigh: r.criticalHigh, displayText: r.displayText,
  }
}

async function load(ex: Pick<WriteExecutor, 'select'>, labTestIds: number[], includeInactive: boolean): Promise<Map<number, AnalyteRecord[]>> {
  const out = new Map<number, AnalyteRecord[]>()
  if (labTestIds.length === 0) return out
  const rows: LabTestAnalyteRow[] = await ex.select().from(labTestAnalytes)
    .where(includeInactive ? inArray(labTestAnalytes.labTestId, labTestIds) : and(inArray(labTestAnalytes.labTestId, labTestIds), eq(labTestAnalytes.isActive, true)))
    .orderBy(asc(labTestAnalytes.labTestId), asc(labTestAnalytes.sortOrder), asc(labTestAnalytes.id))
  if (rows.length === 0) return out
  const ranges: LabAnalyteRangeRow[] = await ex.select().from(labAnalyteRanges)
    .where(inArray(labAnalyteRanges.analyteId, rows.map((r) => r.id)))
    .orderBy(asc(labAnalyteRanges.id))
  const byAnalyte = new Map<number, AnalyteRange[]>()
  for (const r of ranges) byAnalyte.set(r.analyteId, [...(byAnalyte.get(r.analyteId) ?? []), toRange(r)])
  for (const a of rows) {
    const rec: AnalyteRecord = {
      id: a.id, code: a.code, name: a.name, unit: a.unit, valueType: a.valueType, decimals: a.decimals,
      options: a.options ?? null, abnormalOptions: a.abnormalOptions ?? null, criticalOptions: a.criticalOptions ?? null,
      ranges: byAnalyte.get(a.id) ?? [], loincCode: a.loincCode, isActive: a.isActive,
    }
    out.set(a.labTestId, [...(out.get(a.labTestId) ?? []), rec])
  }
  return out
}

/** A test's analytes in display order (active only unless asked). */
export async function listAnalytesForTest(labTestId: number, opts?: { includeInactive?: boolean }): Promise<AnalyteRecord[]> {
  return (await load(getDb(), [labTestId], opts?.includeInactive ?? false)).get(labTestId) ?? []
}

/** Active analytes for several tests (tests without analytes are absent from the map). */
export async function listAnalytesForTests(labTestIds: number[]): Promise<Map<number, AnalyteRecord[]>> {
  return load(getDb(), [...new Set(labTestIds)], false)
}

/** The setup editor's load: null for an unknown test. */
export async function getLabTestWithAnalytes(labTestId: number): Promise<{ test: { id: number; name: string; code: string }; analytes: AnalyteRecord[] } | null> {
  const [test] = await getDb().select({ id: labTests.id, name: labTests.name, code: labTests.code }).from(labTests).where(eq(labTests.id, labTestId)).limit(1)
  if (!test) return null
  return { test, analytes: await listAnalytesForTest(labTestId) }
}

/**
 * Replaces a test's analyte list. Upsert by `code` (the id, and so every stored result value,
 * stays attached); list position is the sort order; each kept analyte's ranges are replaced.
 * An analyte left out is deactivated when it has result values, else deleted (ranges cascade).
 */
export async function replaceAnalytesForTest(
  labTestId: number,
  defs: AnalyteDefinitionInput[],
  session: Session,
): Promise<{ ok: true } | { ok: false; error: 'not_found' }> {
  return getDb().transaction(async (tx) => {
    // Row lock: two editors saving the same test apply one after the other.
    const [test] = await tx.select({ id: labTests.id }).from(labTests).where(eq(labTests.id, labTestId)).for('update')
    if (!test) return { ok: false as const, error: 'not_found' as const }

    const existing = await tx.select({ id: labTestAnalytes.id, code: labTestAnalytes.code }).from(labTestAnalytes).where(eq(labTestAnalytes.labTestId, labTestId))
    const idByCode = new Map(existing.map((a) => [a.code, a.id]))
    const keptIds: number[] = []

    for (const [i, d] of defs.entries()) {
      const fields = {
        name: d.name, unit: d.unit, valueType: d.valueType, decimals: d.decimals, sortOrder: i, loincCode: d.loincCode,
        options: d.options, abnormalOptions: d.abnormalOptions, criticalOptions: d.criticalOptions, isActive: true,
      }
      let id = idByCode.get(d.code)
      if (id === undefined) {
        const [row] = await tx.insert(labTestAnalytes).values({ labTestId, code: d.code, ...fields }).returning({ id: labTestAnalytes.id })
        id = row.id
      } else {
        await tx.update(labTestAnalytes).set(fields).where(eq(labTestAnalytes.id, id))
        await tx.delete(labAnalyteRanges).where(eq(labAnalyteRanges.analyteId, id))
      }
      keptIds.push(id)
      if (d.ranges.length > 0) await tx.insert(labAnalyteRanges).values(d.ranges.map((r) => ({ analyteId: id, ...r })))
    }

    const droppedIds = existing.map((a) => a.id).filter((id) => !keptIds.includes(id))
    if (droppedIds.length > 0) {
      const used = new Set((await tx.selectDistinct({ id: labResultValues.analyteId }).from(labResultValues)
        .where(inArray(labResultValues.analyteId, droppedIds))).map((r) => r.id))
      const deactivate = droppedIds.filter((id) => used.has(id))
      const remove = droppedIds.filter((id) => !used.has(id))
      if (deactivate.length > 0) await tx.update(labTestAnalytes).set({ isActive: false }).where(inArray(labTestAnalytes.id, deactivate))
      if (remove.length > 0) await tx.delete(labTestAnalytes).where(inArray(labTestAnalytes.id, remove))
    }

    await logAudit(session, 'updated lab test analytes', null, `test=${labTestId} count=${defs.length}`, tx)
    return { ok: true as const }
  })
}
