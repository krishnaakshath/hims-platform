import { describe, it, expect, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { getDb } from '@/db/client'
import { auditLog, labTests, labOrders, labResults, labTestAnalytes, labResultValues, patients, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { AnalyteDefinitionInput } from '@/lib/labs/validation'
import { listAnalytesForTest, listAnalytesForTests, replaceAnalytesForTest } from '@/lib/queries/lab-analytes'

// WS4 T8: analyte definitions per test, upserted by code; an analyte with results is kept inactive.
const TAG = randomBytes(4).toString('hex').toUpperCase()
const PROBE = `TEST_WS4T8-${TAG}`
const S: Session = { role: 'admin', name: PROBE, userId: null }
const PID = `TEST-WS4T8Q-${TAG}`
const testIds: number[] = []
const orderIds: number[] = []

const def = (code: string, extra: Partial<AnalyteDefinitionInput> = {}): AnalyteDefinitionInput => ({
  code, name: `Analyte ${code}`, unit: 'g/dL', valueType: 'numeric', decimals: 1, loincCode: null,
  options: null, abnormalOptions: null, criticalOptions: null,
  ranges: [{ sex: 'any', ageMinDays: 0, ageMaxDays: null, normalLow: 12, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20, displayText: null }],
  ...extra,
})

async function newTest() {
  const [t] = await getDb().insert(labTests).values({ name: `TEST WS4 T8 Q ${TAG}`, code: `TEST-WS4T8Q-${TAG}-${testIds.length}` }).returning()
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
  await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
})

describe.skipIf(!process.env.DATABASE_URL)('lab analytes (DB)', () => {
  it('replaces, lists in order with ranges, and audits ids and the count only', async () => {
    const testId = await newTest()
    expect(await replaceAnalytesForTest(testId, [def('HGB'), def('PLT', { unit: '10^3/µL', decimals: 0, ranges: [] })], S)).toEqual({ ok: true })
    const list = await listAnalytesForTest(testId)
    expect(list.map((a) => a.code)).toEqual(['HGB', 'PLT'])
    expect(list[0]).toMatchObject({ unit: 'g/dL', valueType: 'numeric', decimals: 1, isActive: true })
    expect(list[0].ranges).toEqual([{ sex: 'any', ageMinDays: 0, ageMaxDays: null, normalLow: 12, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20, displayText: null }])
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'updated lab test analytes')))
    expect(audit.details).toBe(`test=${testId} count=2`)

    // Upsert by code: HGB keeps its id, its ranges are replaced; PLT dropped (no results) is deleted.
    const hgbId = list[0].id
    await replaceAnalytesForTest(testId, [def('WBC'), def('HGB', { ranges: [] })], S)
    const again = await listAnalytesForTest(testId, { includeInactive: true })
    expect(again.map((a) => a.code)).toEqual(['WBC', 'HGB'])
    expect(again.find((a) => a.code === 'HGB')).toMatchObject({ id: hgbId, ranges: [] })

    const byTest = await listAnalytesForTests([testId])
    expect(byTest.get(testId)?.map((a) => a.code)).toEqual(['WBC', 'HGB'])
  })

  it('an analyte with results is deactivated, not deleted, when dropped; re-adding it reactivates it', async () => {
    const db = getDb()
    const testId = await newTest()
    await replaceAnalytesForTest(testId, [def('HGB'), def('WBC')], S)
    const [hgb] = (await listAnalytesForTest(testId)).filter((a) => a.code === 'HGB')
    await db.insert(patients).values({ id: PID, name: 'Test WS4 T8 Q', dob: '1990-01-01' }).onConflictDoNothing()
    const [provider] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    const [o] = await db.insert(labOrders).values({ patientId: PID, labTestId: testId, orderedByProviderId: provider.id, status: 'resulted' }).returning()
    orderIds.push(o.id)
    const [r] = await db.insert(labResults).values({ labOrderId: o.id, value: '2 analytes', resultedByName: 'Probe' }).returning()
    await db.insert(labResultValues).values({ labResultId: r.id, labOrderId: o.id, analyteId: hgb.id, valueText: '13.0', valueNumeric: 13, flag: 'normal', interpretation: 'N', flagSource: 'auto' })

    await replaceAnalytesForTest(testId, [def('WBC')], S)
    expect((await listAnalytesForTest(testId)).map((a) => a.code)).toEqual(['WBC'])
    const all = await listAnalytesForTest(testId, { includeInactive: true })
    expect(all.find((a) => a.code === 'HGB')).toMatchObject({ id: hgb.id, isActive: false })
    expect((await listAnalytesForTests([testId])).get(testId)?.map((a) => a.code)).toEqual(['WBC'])

    await replaceAnalytesForTest(testId, [def('WBC'), def('HGB')], S)
    expect((await listAnalytesForTest(testId)).find((a) => a.code === 'HGB')).toMatchObject({ id: hgb.id, isActive: true })
  })

  it('an unknown test is not_found', async () => {
    expect(await replaceAnalytesForTest(2147483000, [def('HGB')], S)).toEqual({ ok: false, error: 'not_found' })
  })
})
