// WS4 T9 (spec 3.3 items 18-20): per-analyte result values. `lab_results` keeps one summary row per
// order (every existing reader works unchanged); the detail rows here carry a snapshot of the unit
// and range text, the automatic flag (src/lib/labs/analytes.ts, the same rules the entry form runs)
// and any raise-only manual override with its reason. Written on the caller's transaction, under
// the order lock taken by recordLabResult.
import { asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { labResultValues, labTestAnalytes } from '@/db/schema'
import {
  ageInDays, flagAnalyteValue, rangeText, selectRange, worstFlag,
  type AnalyteDef, type Interpretation, type LabResultFlag,
} from '@/lib/labs/analytes'
import type { AnalyteResultRequest } from '@/lib/labs/validation'
import type { WriteExecutor } from '@/lib/queries/executor'

export type AnalyteEntryError = 'analytes_required' | 'analyte_unknown' | 'analyte_missing' | 'flag_required' | 'flag_below_computed' | 'invalid_numeric'

export interface AnalyteResultSummary { value: string; unit: string | null; referenceRange: string | null; flag: LabResultFlag }

export interface AnalyteResultRow {
  analyteId: number
  code: string
  name: string
  value: string
  unit: string | null
  referenceRange: string | null
  flag: LabResultFlag
  interpretation: Interpretation | null
  flagSource: 'auto' | 'manual'
  /** The technician's reason for a manual flag (prefills an amendment). */
  flagReason: string | null
}

const SEVERITY: Record<LabResultFlag, number> = { normal: 0, abnormal: 1, critical: 2 }
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/
const COMPARATOR = /^(<=?|>=?|≤|≥)\s*\d+(\.\d+)?$/
// numeric(14,4) holds |x| < 1e10.
const NUMERIC_LIMIT = 1e10

/** Patient sex for range choice: only male/female select sex-specific ranges (spec 3.3 item 20). */
export function rangeSexOf(gender: string | null): 'male' | 'female' | null {
  return gender === 'male' || gender === 'female' ? gender : null
}

/** The interpretation of a manual flag: directional when it raises an L/H, else N / A / AA. */
function manualInterpretation(flag: LabResultFlag, computed: Interpretation | null): Interpretation {
  if (flag === 'critical' && computed === 'L') return 'LL'
  if (flag === 'critical' && computed === 'H') return 'HH'
  return flag === 'critical' ? 'AA' : flag === 'abnormal' ? 'A' : 'N'
}

type EvaluatedRow = Omit<typeof labResultValues.$inferInsert, 'id' | 'labResultId' | 'labOrderId'>
type Evaluation = { ok: true; rows: EvaluatedRow[]; summary: AnalyteResultSummary } | { ok: false; error: AnalyteEntryError; analyteId?: number }

/**
 * Pure: checks a per-analyte body against the test's active analytes and computes every row and
 * the summary. Every active analyte must be present; nothing else may be.
 */
export function evaluateAnalyteEntries(i: {
  patient: { dob: string; gender: string | null }
  onDate: string
  defs: AnalyteDef[]
  entries: AnalyteResultRequest['analytes']
}): Evaluation {
  if (i.defs.length === 0) return { ok: false, error: 'analyte_unknown' }
  const byId = new Map(i.defs.map((d) => [d.id, d]))
  for (const e of i.entries) if (!byId.has(e.analyteId)) return { ok: false, error: 'analyte_unknown', analyteId: e.analyteId }
  const entryById = new Map(i.entries.map((e) => [e.analyteId, e]))
  for (const d of i.defs) if (!entryById.has(d.id)) return { ok: false, error: 'analyte_missing', analyteId: d.id }

  const sex = rangeSexOf(i.patient.gender)
  const ageDays = ageInDays(i.patient.dob, i.onDate)
  const rows: EvaluatedRow[] = []
  for (const def of i.defs) {
    const e = entryById.get(def.id)!
    const value = e.value.trim()
    let valueNumeric: number | null = null
    if (def.valueType === 'numeric') {
      if (PLAIN_NUMBER.test(value)) {
        valueNumeric = Number(value)
        if (Math.abs(valueNumeric) >= NUMERIC_LIMIT) return { ok: false, error: 'invalid_numeric', analyteId: def.id }
      } else if (!COMPARATOR.test(value)) {
        return { ok: false, error: 'invalid_numeric', analyteId: def.id }
      }
    }
    const range = selectRange(def.ranges, sex, ageDays)
    const computed = flagAnalyteValue(def, value, range)
    const override = e.flagOverride
    let flag: LabResultFlag
    let interpretation: Interpretation | null
    let flagSource: 'auto' | 'manual' = 'auto'
    let flagReason: string | null = null
    if (computed === null) {
      if (!override) return { ok: false, error: 'flag_required', analyteId: def.id }
      flag = override.flag
      interpretation = manualInterpretation(flag, null)
      flagSource = 'manual'
      flagReason = override.reason.trim()
    } else if (override && SEVERITY[override.flag] < SEVERITY[computed.flag]) {
      return { ok: false, error: 'flag_below_computed', analyteId: def.id }
    } else if (override && SEVERITY[override.flag] > SEVERITY[computed.flag]) {
      flag = override.flag
      interpretation = manualInterpretation(flag, computed.interpretation)
      flagSource = 'manual'
      flagReason = override.reason.trim()
    } else {
      // No override, or one equal to the computed flag: the automatic flag stands.
      flag = computed.flag
      interpretation = computed.interpretation
    }
    rows.push({
      analyteId: def.id, valueText: value, valueNumeric, unit: def.unit, referenceRangeText: rangeText(range, def.unit),
      flag, interpretation, flagSource, flagReason,
    })
  }

  const one = rows.length === 1 ? rows[0] : null
  const summary: AnalyteResultSummary = {
    value: one ? one.valueText : `${rows.length} analytes`,
    unit: one ? (one.unit ?? null) : null,
    referenceRange: one ? (one.referenceRangeText ?? null) : null,
    flag: worstFlag(rows.map((r) => r.flag as LabResultFlag)),
  }
  return { ok: true, rows, summary }
}

/**
 * Validates and writes an order's analyte values (replacing any earlier ones: an amendment).
 * On a refusal nothing is written. Every active analyte must be present.
 */
export async function writeAnalyteResults(tx: WriteExecutor, i: {
  orderId: number
  labResultId: number
  patient: { dob: string; gender: string | null }
  onDate: string
  defs: AnalyteDef[]
  entries: AnalyteResultRequest['analytes']
}): Promise<{ ok: true; summary: AnalyteResultSummary } | { ok: false; error: AnalyteEntryError; analyteId?: number }> {
  const ev = evaluateAnalyteEntries(i)
  if (!ev.ok) return ev
  await tx.delete(labResultValues).where(eq(labResultValues.labOrderId, i.orderId))
  await tx.insert(labResultValues).values(ev.rows.map((r) => ({ ...r, labResultId: i.labResultId, labOrderId: i.orderId })))
  return { ok: true, summary: ev.summary }
}

/** Each order's analyte values in the test's display order (orders without any are absent). */
export async function listAnalyteResults(orderIds: number[]): Promise<Map<number, AnalyteResultRow[]>> {
  const out = new Map<number, AnalyteResultRow[]>()
  if (orderIds.length === 0) return out
  const rows = await getDb()
    .select({ v: labResultValues, code: labTestAnalytes.code, name: labTestAnalytes.name })
    .from(labResultValues)
    .innerJoin(labTestAnalytes, eq(labTestAnalytes.id, labResultValues.analyteId))
    .where(inArray(labResultValues.labOrderId, [...new Set(orderIds)]))
    .orderBy(asc(labResultValues.labOrderId), asc(labTestAnalytes.sortOrder), asc(labTestAnalytes.id))
  for (const { v, code, name } of rows) {
    const row: AnalyteResultRow = {
      analyteId: v.analyteId, code, name, value: v.valueText, unit: v.unit, referenceRange: v.referenceRangeText,
      flag: v.flag, interpretation: v.interpretation, flagSource: v.flagSource, flagReason: v.flagReason,
    }
    out.set(v.labOrderId, [...(out.get(v.labOrderId) ?? []), row])
  }
  return out
}
