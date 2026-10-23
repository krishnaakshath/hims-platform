// WS4 T12 (spec 3.5 items 23-26): critical-value alerts against real Postgres -- raised in the
// result transaction, withdrawn by a non-critical amendment, never duplicated; verification waits
// for the call log; the ordering doctor's acknowledgement closes the alert with a sign-off.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { getDb } from '@/db/client'
import { auditLog, labCriticalAlerts, labOrders, labResultSignoffs, labResultValues, labResults, labTestAnalytes, labTests, patients, users } from '@/db/schema'
import { LAB_ANALYTE_SEED } from '@/db/seed-india-data'
import type { Session } from '@/lib/auth'
import type { AnalyteResultRequest } from '@/lib/labs/validation'
import { collectLabOrder, receiveLabSample, recordLabResult, verifyLabResult } from '@/lib/queries/lab-lifecycle'
import { replaceAnalytesForTest } from '@/lib/queries/lab-analytes'
import {
  acknowledgeCriticalAlert, acknowledgeableCriticalOrderIds, criticalNotifyDenial, criticalSummaryText, listOpenCriticalAlerts, logCriticalNotification,
} from '@/lib/queries/lab-critical'
import { loadLabKpis } from '@/lib/queries/hospital-kpis'
import { createLabDepartmentFixture, type LabDepartmentFixture } from '../../db/lab-verifier-fixtures'

const TAG = randomBytes(4).toString('hex').toUpperCase()
const PID = `TEST-WS4T12-${TAG}` // a woman, 30 years old
const NAME_TECH = `TEST_WS4T12 Tech ${TAG}`
const NAME_PATH = `TEST_WS4T12 Pathologist ${TAG}`
const NAME_ORDERING = `TEST_WS4T12 Dr Ordering ${TAG}`
const NAME_OTHER = `TEST_WS4T12 Dr Other ${TAG}`
const NAMES = [NAME_TECH, NAME_PATH, NAME_ORDERING, NAME_OTHER]
const COLLECT = new Date('2099-05-01T04:00:00Z')
const RESULT = new Date('2099-05-01T05:00:00Z')
const CALL = new Date('2099-05-01T05:12:00Z') // 10:42 IST

let lab: LabDepartmentFixture
let gen: LabDepartmentFixture
let cbcTestId = 0
let orderingProvider = 0
const userIds: Record<string, number> = {}
const orderIds: number[] = []
const analyteIds = new Map<string, number>()
const tech = (): Session => ({ role: 'labs', name: NAME_TECH, userId: userIds[NAME_TECH] })
const pathologist = (): Session => ({ role: 'labs', name: NAME_PATH, userId: userIds[NAME_PATH] })
const doctor = (name: string): Session => ({ role: 'pi', name, userId: userIds[name] })

const NORMAL: Record<string, string> = {
  HGB: '13.1', WBC: '7.2', NEUT: '60', LYMPH: '30', MONO: '6', EOS: '3', BASO: '1', PLT: '250', RBC: '4.6', HCT: '40', MCV: '88', MCH: '29', MCHC: '33',
}
const cbc = (over: Record<string, string> = {}): AnalyteResultRequest => ({
  analytes: Object.entries({ ...NORMAL, ...over }).map(([code, value]) => ({ analyteId: analyteIds.get(code)!, value })),
})

async function receivedOrder() {
  const [o] = await getDb().insert(labOrders).values({ patientId: PID, labTestId: cbcTestId, orderedByProviderId: orderingProvider }).returning()
  orderIds.push(o.id)
  const c = await collectLabOrder(o.id, tech(), COLLECT)
  if (!c.ok) throw new Error('collect failed')
  const r = await receiveLabSample(c.sampleId, tech(), COLLECT)
  if (!r.ok) throw new Error('receive failed')
  return o.id
}
const alertsOf = (orderId: number) => getDb().select().from(labCriticalAlerts).where(eq(labCriticalAlerts.labOrderId, orderId))

describe('criticalSummaryText', () => {
  it('lists the critical analytes with units, else the single value', () => {
    expect(criticalSummaryText({ testName: 'CBC', value: '13 analytes', unit: null, analytes: [
      { name: 'Haemoglobin', value: '6.5', unit: 'g/dL', flag: 'critical' },
      { name: 'WBC', value: '7.2', unit: '10^3/µL', flag: 'normal' },
      { name: 'Platelets', value: '38', unit: '×10³/µL', flag: 'critical' },
    ] })).toBe('Haemoglobin 6.5 g/dL; Platelets 38 ×10³/µL')
    expect(criticalSummaryText({ testName: 'Serum potassium', value: '6.9', unit: 'mmol/L' })).toBe('Serum potassium 6.9 mmol/L')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('critical-value alerts (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS4T12 Lakshmi', dob: '2069-03-01', gender: 'female' })
    const us = await db.insert(users).values(NAMES.map((name, i) => ({ name, email: `test-ws4t12-${TAG.toLowerCase()}-${i}@example.invalid`, role: i < 2 ? 'labs' as const : 'pi' as const }))).returning()
    for (const u of us) userIds[u.name] = u.id
    const [t] = await db.insert(labTests).values({ name: `TEST WS4T12 CBC ${TAG}`, code: `TEST-WS4T12-CBC-${TAG}` }).returning()
    cbcTestId = t.id
    expect(await replaceAnalytesForTest(cbcTestId, LAB_ANALYTE_SEED['CBC-DIFF'], { role: 'admin', name: NAME_TECH, userId: null })).toEqual({ ok: true })
    for (const a of await db.select({ id: labTestAnalytes.id, code: labTestAnalytes.code }).from(labTestAnalytes).where(eq(labTestAnalytes.labTestId, cbcTestId))) analyteIds.set(a.code, a.id)
    lab = await createLabDepartmentFixture(`CL${TAG}`)
    gen = await createLabDepartmentFixture(`CG${TAG}`)
    await lab.mapTests([cbcTestId])
    await lab.linkUsers([userIds[NAME_PATH]], `TEST_WS4T12 Dr Path ${TAG}`)
    orderingProvider = await gen.linkUsers([userIds[NAME_ORDERING]], `TEST_WS4T12 Dr Ordering prov ${TAG}`)
    await gen.linkUsers([userIds[NAME_OTHER]], `TEST_WS4T12 Dr Other prov ${TAG}`)
  }, 60_000)

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length) {
      await db.delete(labResultValues).where(inArray(labResultValues.labOrderId, orderIds))
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds)) // alerts and sign-offs cascade
      await db.delete(labTestAnalytes).where(eq(labTestAnalytes.labTestId, cbcTestId))
    }
    await db.delete(auditLog).where(inArray(auditLog.userName, NAMES))
    await lab?.cleanup()
    await gen?.cleanup()
    await db.delete(labTests).where(eq(labTests.id, cbcTestId))
    await db.delete(users).where(inArray(users.id, Object.values(userIds)))
    await db.delete(patients).where(eq(patients.id, PID))
  }, 60_000)

  it('a critical CBC raises one open alert; verify waits for the call; the call needs read-back by phone; the doctor acknowledges', async () => {
    const before = await loadLabKpis('2099-05-01')
    const id = await receivedOrder()
    const r = await recordLabResult(id, cbc({ HGB: '6.5', PLT: '38' }), { kind: 'staff', session: tech() }, { now: RESULT })
    expect(r).toMatchObject({ ok: true, flag: 'critical' })
    const [alert, ...rest] = await alertsOf(id)
    expect(rest).toEqual([])
    expect(alert).toMatchObject({ status: 'open', patientId: PID, summary: 'Haemoglobin 6.5 g/dL; Platelet count 38 10^3/µL' })
    expect((await loadLabKpis('2099-05-01')).criticalOpen - before.criticalOpen).toBe(1)

    const listed = await listOpenCriticalAlerts({ patientId: PID })
    expect(listed.map((a) => a.orderId)).toContain(id)
    expect((await listOpenCriticalAlerts({ providerId: orderingProvider })).map((a) => a.orderId)).toContain(id)
    expect(await acknowledgeableCriticalOrderIds(doctor(NAME_ORDERING), { patientId: PID })).toContain(id)
    expect(await acknowledgeableCriticalOrderIds(doctor(NAME_OTHER), { patientId: PID })).not.toContain(id)

    // Verify while open: refused, nothing changes.
    expect(await verifyLabResult(id, pathologist(), CALL)).toEqual({ ok: false, error: 'critical_not_notified' })

    // The pathologist (linked to the test's department) may log the call; another department's doctor may not.
    expect(await criticalNotifyDenial(id, pathologist())).toBeNull()
    expect(await criticalNotifyDenial(id, doctor(NAME_OTHER))).toBe('wrong_department')
    expect(await criticalNotifyDenial(2147483000, doctor(NAME_OTHER))).toBe('not_found')

    expect(await logCriticalNotification(id, { notifiedToName: 'Dr Rao', channel: 'phone', readBack: false }, tech(), CALL)).toEqual({ ok: false, error: 'read_back_required' })
    expect((await alertsOf(id))[0].status).toBe('open')
    expect(await logCriticalNotification(id, { notifiedToName: ' Dr Rao ', channel: 'phone', readBack: true }, tech(), CALL)).toEqual({ ok: true })
    expect((await alertsOf(id))[0]).toMatchObject({
      status: 'notified', notifiedToName: 'Dr Rao', notifyChannel: 'phone', readBack: true, notifiedByName: NAME_TECH, notifiedByUserId: userIds[NAME_TECH], notifiedAt: CALL,
    })
    expect(await logCriticalNotification(id, { notifiedToName: 'Dr Rao', channel: 'in_person', readBack: false }, tech(), CALL)).toEqual({ ok: false, error: 'not_open' })
    // Still counted until acknowledged.
    expect((await loadLabKpis('2099-05-01')).criticalOpen - before.criticalOpen).toBe(1)

    expect(await verifyLabResult(id, pathologist(), CALL)).toMatchObject({ ok: true })

    // Another doctor cannot acknowledge; the ordering doctor can, once, with a sign-off.
    expect(await acknowledgeCriticalAlert(id, null, doctor(NAME_OTHER), CALL)).toEqual({ ok: false, error: 'not_owner' })
    expect(await acknowledgeCriticalAlert(id, null, { role: 'admin', name: 'TEST env admin', userId: null }, CALL)).toEqual({ ok: false, error: 'not_owner' })
    expect(await acknowledgeCriticalAlert(id, 'Transfusing 2 units', doctor(NAME_ORDERING), CALL)).toEqual({ ok: true, providerId: orderingProvider })
    expect((await alertsOf(id))[0]).toMatchObject({ status: 'acknowledged', acknowledgedByName: NAME_ORDERING, ackNote: 'Transfusing 2 units' })
    const signoffs = await getDb().select().from(labResultSignoffs).where(and(eq(labResultSignoffs.labOrderId, id), eq(labResultSignoffs.kind, 'acknowledge')))
    expect(signoffs.map((s) => s.providerId)).toEqual([orderingProvider])
    expect(await acknowledgeCriticalAlert(id, null, doctor(NAME_ORDERING), CALL)).toEqual({ ok: false, error: 'already_acknowledged' })

    expect((await loadLabKpis('2099-05-01')).criticalOpen).toBe(before.criticalOpen)
    expect((await listOpenCriticalAlerts({ patientId: PID })).map((a) => a.orderId)).not.toContain(id)

    // Audits carry ids only, never the called name or the note.
    const audits = await getDb().select().from(auditLog).where(inArray(auditLog.userName, [NAME_TECH, NAME_ORDERING]))
    const critical = audits.filter((a) => a.action === 'logged critical result call' || a.action === 'acknowledged critical result')
    expect(critical.map((a) => a.action).sort()).toEqual(['acknowledged critical result', 'logged critical result call'])
    expect(JSON.stringify(critical)).not.toMatch(/Dr Rao|Transfusing/)
  })

  it('a critical amendment never duplicates; a non-critical one withdraws; critical again re-opens the same row', async () => {
    const id = await receivedOrder()
    const staff = { kind: 'staff' as const, session: tech() }
    expect(await recordLabResult(id, cbc({ PLT: '38' }), staff, { now: RESULT })).toMatchObject({ ok: true, flag: 'critical' })
    expect(await recordLabResult(id, cbc({ PLT: '31' }), staff, { now: CALL })).toMatchObject({ ok: true, amended: true, flag: 'critical' })
    let rows = await alertsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'open', summary: 'Platelet count 31 10^3/µL' })

    expect(await recordLabResult(id, cbc(), staff, { now: CALL })).toMatchObject({ ok: true, flag: 'normal' })
    rows = await alertsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'withdrawn', withdrawnAt: CALL })
    // A withdrawn alert is not open: verification proceeds, notify and acknowledge refuse.
    expect(await logCriticalNotification(id, { notifiedToName: 'Dr Rao', channel: 'in_app', readBack: false }, tech(), CALL)).toEqual({ ok: false, error: 'not_open' })
    expect(await acknowledgeCriticalAlert(id, null, doctor(NAME_ORDERING), CALL)).toEqual({ ok: false, error: 'withdrawn' })

    expect(await recordLabResult(id, cbc({ HGB: '6.5' }), staff, { now: CALL })).toMatchObject({ ok: true, flag: 'critical' })
    rows = await alertsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'open', withdrawnAt: null, summary: 'Haemoglobin 6.5 g/dL' })
  })

  it('a missing order or an order without an alert is not_found', async () => {
    expect(await logCriticalNotification(2147483000, { notifiedToName: 'X', channel: 'in_app', readBack: false }, tech())).toEqual({ ok: false, error: 'not_found' })
    const id = await receivedOrder()
    expect(await acknowledgeCriticalAlert(id, null, doctor(NAME_ORDERING))).toEqual({ ok: false, error: 'not_found' })
  })

  it('deleting the order deletes its alert (cascade)', async () => {
    const id = await receivedOrder()
    await recordLabResult(id, cbc({ PLT: '38' }), { kind: 'staff', session: tech() }, { now: RESULT })
    expect(await alertsOf(id)).toHaveLength(1)
    await getDb().delete(labResultValues).where(eq(labResultValues.labOrderId, id))
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
    expect(await alertsOf(id)).toEqual([])
  })
})
