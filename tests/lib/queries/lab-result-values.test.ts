import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { getDb } from '@/db/client'
import { auditLog, labOrders, labResultValues, labResults, labTestAnalytes, labTests, patients, providers } from '@/db/schema'
import { LAB_ANALYTE_SEED } from '@/db/seed-india-data'
import type { Session } from '@/lib/auth'
import type { AnalyteResultRequest } from '@/lib/labs/validation'
import { collectLabOrder, receiveLabSample, recordLabResult } from '@/lib/queries/lab-lifecycle'
import { replaceAnalytesForTest } from '@/lib/queries/lab-analytes'
import { listAnalyteResults } from '@/lib/queries/lab-result-values'
import { listOrdersForPatient } from '@/lib/queries/lab-orders'

// WS4 T9 (spec 3.3 items 18-20): per-analyte result entry, automatic flags, raise-only overrides.
const TAG = randomBytes(4).toString('hex').toUpperCase()
const PROBE = `TEST_WS4T9-${TAG}`
const S: Session = { role: 'labs', name: PROBE, userId: null }
const STAFF = { kind: 'staff' as const, session: S }
const PF = `TEST-WS4T9-${TAG}-F` // female, 30 years old at collection
const COLLECT = new Date('2099-05-01T05:00:00Z') // 1 May 2099 IST
const LATER = new Date('2099-05-01T09:00:00Z')
const AMEND = new Date('2099-05-02T05:00:00Z')

let providerId = 0
let cbcTestId = 0
let textTestId = 0
let plainTestId = 0
const orderIds: number[] = []
const ids = new Map<string, number>() // CBC analyte code -> id
let textAnalyteId = 0

/** Every CBC analyte normal for an adult woman, as code -> value. */
const NORMAL: Record<string, string> = {
  HGB: '13.1', WBC: '7.2', NEUT: '60', LYMPH: '30', MONO: '6', EOS: '3', BASO: '1', PLT: '250', RBC: '4.6', HCT: '40', MCV: '88', MCH: '29', MCHC: '33',
}
const body = (values: Record<string, string>, extra: Partial<Record<string, AnalyteResultRequest['analytes'][number]['flagOverride']>> = {}): AnalyteResultRequest => ({
  analytes: Object.entries(values).map(([code, value]) => ({ analyteId: ids.get(code)!, value, ...(extra[code] ? { flagOverride: extra[code] } : {}) })),
})

async function receivedOrder(labTestId: number) {
  const [o] = await getDb().insert(labOrders).values({ patientId: PF, labTestId, orderedByProviderId: providerId }).returning()
  orderIds.push(o.id)
  const c = await collectLabOrder(o.id, S, COLLECT)
  if (!c.ok) throw new Error('collect failed')
  const r = await receiveLabSample(c.sampleId, S, COLLECT)
  if (!r.ok) throw new Error('receive failed')
  return o.id
}
const valuesOf = (orderId: number) => getDb().select().from(labResultValues).where(eq(labResultValues.labOrderId, orderId))
const summaryOf = async (orderId: number) => (await getDb().select().from(labResults).where(eq(labResults.labOrderId, orderId)))[0]

describe.skipIf(!process.env.DATABASE_URL)('per-analyte lab results (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PF, name: 'TEST_WS4T9 Female', dob: '2069-05-01', gender: 'female' })
    const [pr] = await db.insert(providers).values({ name: `TEST_WS4T9 Dr ${TAG}`, specialty: 'Pathology', colorTag: '#000000' }).returning()
    providerId = pr.id
    const [cbc, txt, plain] = await db.insert(labTests).values([
      { name: `TEST WS4T9 CBC ${TAG}`, code: `TEST-WS4T9-CBC-${TAG}` },
      { name: `TEST WS4T9 smear ${TAG}`, code: `TEST-WS4T9-TXT-${TAG}` },
      { name: `TEST WS4T9 plain ${TAG}`, code: `TEST-WS4T9-PLN-${TAG}` },
    ]).returning()
    cbcTestId = cbc.id
    textTestId = txt.id
    plainTestId = plain.id
    const admin: Session = { role: 'admin', name: PROBE, userId: null }
    expect(await replaceAnalytesForTest(cbcTestId, LAB_ANALYTE_SEED['CBC-DIFF'], admin)).toEqual({ ok: true })
    expect(await replaceAnalytesForTest(textTestId, [{
      code: 'SMEAR', name: 'Peripheral smear', unit: null, valueType: 'text', decimals: null, loincCode: null, options: null, abnormalOptions: null, criticalOptions: null, ranges: [],
    }], admin)).toEqual({ ok: true })
    for (const a of await db.select().from(labTestAnalytes).where(eq(labTestAnalytes.labTestId, cbcTestId))) ids.set(a.code, a.id)
    textAnalyteId = (await db.select().from(labTestAnalytes).where(eq(labTestAnalytes.labTestId, textTestId)))[0].id
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length) {
      await db.delete(labResultValues).where(inArray(labResultValues.labOrderId, orderIds))
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    }
    await db.delete(labTestAnalytes).where(inArray(labTestAnalytes.labTestId, [cbcTestId, textTestId, plainTestId]))
    await db.delete(labTests).where(inArray(labTests.id, [cbcTestId, textTestId, plainTestId]))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(patients).where(eq(patients.id, PF))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('a CBC for a 30-year-old woman: Hb 6.5 and PLT 38 are critical LL; the summary is critical with "13 analytes"', async () => {
    const id = await receivedOrder(cbcTestId)
    const r = await recordLabResult(id, body({ ...NORMAL, HGB: '6.5', PLT: '38' }), STAFF, { now: LATER })
    expect(r).toEqual({ ok: true, patientId: PF, amended: false, flag: 'critical' })
    const rows = await valuesOf(id)
    expect(rows).toHaveLength(13)
    const byId = new Map(rows.map((v) => [v.analyteId, v]))
    expect(byId.get(ids.get('HGB')!)).toMatchObject({ valueText: '6.5', valueNumeric: 6.5, unit: 'g/dL', referenceRangeText: '12.0-15.5 g/dL', flag: 'critical', interpretation: 'LL', flagSource: 'auto', flagReason: null })
    expect(byId.get(ids.get('PLT')!)).toMatchObject({ flag: 'critical', interpretation: 'LL', flagSource: 'auto' })
    expect(rows.filter((v) => v.flag === 'critical')).toHaveLength(2)
    expect(rows.filter((v) => v.flag === 'normal')).toHaveLength(11)
    expect(await summaryOf(id)).toMatchObject({ value: '13 analytes', unit: null, referenceRange: null, flag: 'critical', resultedByName: PROBE })
    const listed = (await listAnalyteResults([id])).get(id)!
    expect(listed.map((a) => a.code)).toEqual(LAB_ANALYTE_SEED['CBC-DIFF'].map((d) => d.code))
    expect(listed[0]).toEqual({ analyteId: ids.get('HGB'), code: 'HGB', name: 'Haemoglobin', value: '6.5', unit: 'g/dL', referenceRange: '12.0-15.5 g/dL', flag: 'critical', interpretation: 'LL', flagSource: 'auto', flagReason: null, loincCode: '718-7' })
    // WS4 T10: the patient chart (and FHIR) carry the same analyte rows on the order's result.
    const chart = (await listOrdersForPatient(PF)).find((o) => o.id === id)!
    expect(chart.result!.analytes).toEqual(listed)
  })

  it('one analyte missing: 422 analyte_missing and nothing is written', async () => {
    const id = await receivedOrder(cbcTestId)
    const rest = { ...NORMAL }
    delete rest.MCHC
    expect(await recordLabResult(id, body(rest), STAFF, { now: LATER })).toEqual({ ok: false, error: 'analyte_missing', analyteId: ids.get('MCHC') })
    expect(await valuesOf(id)).toHaveLength(0)
    expect(await summaryOf(id)).toBeUndefined()
    expect((await getDb().select({ s: labOrders.status }).from(labOrders).where(eq(labOrders.id, id)))[0].s).toBe('received')
  })

  it('a computed flag cannot be lowered (flag_below_computed); a normal WBC can be raised with a reason', async () => {
    const id = await receivedOrder(cbcTestId)
    expect(await recordLabResult(id, body({ ...NORMAL, HGB: '6.5' }, { HGB: { flag: 'normal', reason: 'Looks fine to me' } }), STAFF, { now: LATER }))
      .toEqual({ ok: false, error: 'flag_below_computed', analyteId: ids.get('HGB') })
    expect(await valuesOf(id)).toHaveLength(0)
    const r = await recordLabResult(id, body(NORMAL, { WBC: { flag: 'abnormal', reason: 'Atypical lymphocytes on smear' } }), STAFF, { now: LATER })
    expect(r).toEqual({ ok: true, patientId: PF, amended: false, flag: 'abnormal' })
    const wbc = (await valuesOf(id)).find((v) => v.analyteId === ids.get('WBC'))
    expect(wbc).toMatchObject({ flag: 'abnormal', flagSource: 'manual', flagReason: 'Atypical lymphocytes on smear', interpretation: 'A' })
  })

  it('a text analyte with no flag is flag_required; with a flag it is stored manual', async () => {
    const id = await receivedOrder(textTestId)
    expect(await recordLabResult(id, { analytes: [{ analyteId: textAnalyteId, value: 'Normocytic normochromic' }] }, STAFF, { now: LATER }))
      .toEqual({ ok: false, error: 'flag_required', analyteId: textAnalyteId })
    expect(await valuesOf(id)).toHaveLength(0)
    const r = await recordLabResult(id, { analytes: [{ analyteId: textAnalyteId, value: 'Normocytic normochromic', flagOverride: { flag: 'normal', reason: 'Smear reviewed' } }] }, STAFF, { now: LATER })
    expect(r).toEqual({ ok: true, patientId: PF, amended: false, flag: 'normal' })
    // One analyte: the summary carries its value.
    expect(await summaryOf(id)).toMatchObject({ value: 'Normocytic normochromic', unit: null, flag: 'normal' })
  })

  it('amendment replaces the rows and sets amendedAt', async () => {
    const id = await receivedOrder(cbcTestId)
    expect((await recordLabResult(id, body({ ...NORMAL, HGB: '6.5' }), STAFF, { now: LATER })).ok).toBe(true)
    const r = await recordLabResult(id, body({ ...NORMAL, HGB: '11.0' }), STAFF, { now: AMEND })
    expect(r).toEqual({ ok: true, patientId: PF, amended: true, flag: 'abnormal' })
    const rows = await valuesOf(id)
    expect(rows).toHaveLength(13)
    expect(rows.find((v) => v.analyteId === ids.get('HGB'))).toMatchObject({ valueText: '11.0', flag: 'abnormal', interpretation: 'L' })
    const s = await summaryOf(id)
    expect(s.flag).toBe('abnormal')
    expect(s.amendedAt?.getTime()).toBe(AMEND.getTime())
    const actions = (await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.details, `order=${id}`)))).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['entered lab result', 'amended lab result']))
  })

  it('a single-value body to a CBC is analytes_required; an analyte body to a test without analytes is analyte_unknown', async () => {
    const id = await receivedOrder(cbcTestId)
    expect(await recordLabResult(id, { value: '13.1', flag: 'normal' }, STAFF, { now: LATER })).toEqual({ ok: false, error: 'analytes_required' })
    expect(await recordLabResult(id, { value: '13.1', flag: 'normal' }, { kind: 'lis' }, { now: LATER })).toEqual({ ok: false, error: 'analytes_required' })
    expect(await summaryOf(id)).toBeUndefined()
    const plain = await receivedOrder(plainTestId)
    expect(await recordLabResult(plain, { analytes: [{ analyteId: ids.get('HGB')!, value: '13' }] }, STAFF, { now: LATER })).toEqual({ ok: false, error: 'analyte_unknown' })
    expect(await summaryOf(plain)).toBeUndefined()
    // An analyte of another test is unknown too.
    expect(await recordLabResult(id, { analytes: [...body(NORMAL).analytes, { analyteId: textAnalyteId, value: 'x' }] }, STAFF, { now: LATER }))
      .toEqual({ ok: false, error: 'analyte_unknown', analyteId: textAnalyteId })
  })

  it('a non-numeric value for a numeric analyte is invalid_numeric; a comparator needs a manual flag', async () => {
    const id = await receivedOrder(cbcTestId)
    expect(await recordLabResult(id, body({ ...NORMAL, PLT: 'clumped' }), STAFF, { now: LATER })).toEqual({ ok: false, error: 'invalid_numeric', analyteId: ids.get('PLT') })
    expect(await recordLabResult(id, body({ ...NORMAL, BASO: '<1' }), STAFF, { now: LATER })).toEqual({ ok: false, error: 'flag_required', analyteId: ids.get('BASO') })
    const r = await recordLabResult(id, body({ ...NORMAL, BASO: '<1' }, { BASO: { flag: 'normal', reason: 'Below counting limit' } }), STAFF, { now: LATER })
    expect(r.ok).toBe(true)
    expect((await valuesOf(id)).find((v) => v.analyteId === ids.get('BASO'))).toMatchObject({ valueText: '<1', valueNumeric: null, flagSource: 'manual' })
  })

  it('single-value tests are unchanged and report their flag', async () => {
    const id = await receivedOrder(plainTestId)
    expect(await recordLabResult(id, { value: '5.4', unit: 'mmol/L', flag: 'abnormal' }, STAFF, { now: LATER })).toEqual({ ok: true, patientId: PF, amended: false, flag: 'abnormal' })
    expect(await valuesOf(id)).toHaveLength(0)
    expect((await listAnalyteResults([id])).get(id)).toBeUndefined()
  })
})
