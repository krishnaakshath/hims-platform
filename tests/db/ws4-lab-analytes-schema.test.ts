import { describe, it, expect, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { getDb } from '@/db/client'
import { labTests, labOrders, labResults, labTestAnalytes, labAnalyteRanges, labResultValues, patients, providers } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

// WS4 T8 (spec §4 rows lab_test_analytes / lab_analyte_ranges / lab_result_values).
const FILE = '2026-10-24-ws4-lab-analytes.sql'
const TAG = randomBytes(4).toString('hex').toUpperCase()
const PID = `TEST-WS4T8-${TAG}`
const testIds: number[] = []
const orderIds: number[] = []

function pgCause(err: unknown): { code?: string; constraint?: string } | undefined {
  return (err as { cause?: { code?: string; constraint?: string } } | null)?.cause
}

async function newTest() {
  const [t] = await getDb().insert(labTests).values({ name: `TEST WS4 T8 ${TAG}`, code: `TEST-WS4T8-${TAG}-${testIds.length}` }).returning()
  testIds.push(t.id)
  return t.id
}

afterAll(async () => {
  const db = getDb()
  if (orderIds.length) {
    await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
    await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
  }
  if (testIds.length) {
    await db.delete(labTestAnalytes).where(inArray(labTestAnalytes.labTestId, testIds))
    await db.delete(labTests).where(inArray(labTests.id, testIds))
  }
  await db.delete(patients).where(eq(patients.id, PID))
})

describe('WS4 T8 lab analyte schema', () => {
  it('migration is idempotent and creates every column of the three tables', () => {
    const s = readMigration(FILE)
    expect(idempotencyProblems(s)).toEqual([])
    expect(missingColumns(labTestAnalytes, s)).toEqual([])
    expect(missingColumns(labAnalyteRanges, s)).toEqual([])
    expect(missingColumns(labResultValues, s)).toEqual([])
    for (const c of ['lab_test_analytes_test_code_unique', 'lab_result_values_result_analyte_unique', 'numeric(14,4)', 'ON DELETE CASCADE']) expect(s).toContain(c)
  })

  it('an analyte code is unique per test', async () => {
    const db = getDb()
    const testId = await newTest()
    await db.insert(labTestAnalytes).values({ labTestId: testId, code: 'HGB', name: 'Haemoglobin' })
    const err = await db.insert(labTestAnalytes).values({ labTestId: testId, code: 'HGB', name: 'Again' }).then(() => null, (e) => e)
    expect(pgCause(err)?.code).toBe('23505')
    expect(pgCause(err)?.constraint).toBe('lab_test_analytes_test_code_unique')
  })

  it('deleting an analyte deletes its ranges; range bounds keep four decimals', async () => {
    const db = getDb()
    const testId = await newTest()
    const [a] = await db.insert(labTestAnalytes).values({ labTestId: testId, code: 'K', name: 'Potassium' }).returning()
    await db.insert(labAnalyteRanges).values({ analyteId: a.id, normalLow: 3.5, normalHigh: 5.1, criticalLow: 2.8, criticalHigh: 6.2 })
    const [r] = await db.select().from(labAnalyteRanges).where(eq(labAnalyteRanges.analyteId, a.id))
    expect(r).toMatchObject({ sex: 'any', ageMinDays: 0, ageMaxDays: null, normalLow: 3.5, normalHigh: 5.1, criticalLow: 2.8, criticalHigh: 6.2 })
    await db.delete(labTestAnalytes).where(eq(labTestAnalytes.id, a.id))
    expect(await db.select().from(labAnalyteRanges).where(eq(labAnalyteRanges.analyteId, a.id))).toEqual([])
  })

  it('refuses unordered range bounds at the database too', async () => {
    const db = getDb()
    const testId = await newTest()
    const [a] = await db.insert(labTestAnalytes).values({ labTestId: testId, code: 'NA', name: 'Sodium' }).returning()
    const err = await db.insert(labAnalyteRanges).values({ analyteId: a.id, normalLow: 145, normalHigh: 135 }).then(() => null, (e) => e)
    expect(pgCause(err)?.code).toBe('23514')
  })

  it('result values are unique per (result, analyte) and go with their lab result', async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'Test WS4 T8', dob: '1990-01-01' }).onConflictDoNothing()
    const [provider] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    const testId = await newTest()
    const [a] = await db.insert(labTestAnalytes).values({ labTestId: testId, code: 'HGB', name: 'Haemoglobin' }).returning()
    const [o] = await db.insert(labOrders).values({ patientId: PID, labTestId: testId, orderedByProviderId: provider.id, status: 'resulted' }).returning()
    orderIds.push(o.id)
    const [res] = await db.insert(labResults).values({ labOrderId: o.id, value: '13.0', resultedByName: 'Probe' }).returning()
    const row = { labResultId: res.id, labOrderId: o.id, analyteId: a.id, valueText: '13.0', valueNumeric: 13, flag: 'normal' as const, interpretation: 'N' as const, flagSource: 'auto' as const }
    await db.insert(labResultValues).values(row)
    const dup = await db.insert(labResultValues).values(row).then(() => null, (e) => e)
    expect(pgCause(dup)?.constraint).toBe('lab_result_values_result_analyte_unique')
    // An analyte with results cannot be deleted out from under them.
    const fk = await db.delete(labTestAnalytes).where(eq(labTestAnalytes.id, a.id)).then(() => null, (e) => e)
    expect(pgCause(fk)?.code).toBe('23503')
    await db.delete(labResults).where(eq(labResults.id, res.id))
    expect(await db.select().from(labResultValues).where(eq(labResultValues.labResultId, res.id))).toEqual([])
  })
})
