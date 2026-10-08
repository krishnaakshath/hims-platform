import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, followUpOrders, labOrders, labReports, labRequisitions, labResults, labTests, patients, providers, users } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { LabReportData } from '@/lib/labs/report-data'
import { verifyLabResult } from '@/lib/queries/lab-lifecycle'
import {
  getLabReportForDownload, listPortalLabReports, listReportsForPatient, releaseLabReport, type ReleaseDeps,
} from '@/lib/queries/lab-reports'

const RUN = `${Date.now()}`
const PROBE = `TEST_SP5_REPORT-${RUN}`
const PROBE_VERIFIER = `TEST_SP5_REPORT_V-${RUN}`
const PROBE_NAMES = [PROBE, PROBE_VERIFIER]
const S: Session = { role: 'labs', name: PROBE, userId: null }
const NOW = new Date('2099-08-01T05:00:00Z') // 10:30 IST, 1 Aug 2099
const BYTES = new Uint8Array([37, 80, 68, 70, 45, 49])

let providerId = 0
let inactiveProviderId = 0
let enterer = 0
let verifierId = 0
let VERIFIER: Session
const testIds: number[] = []
const patientIds: string[] = []
let seq = 0

const rendered: LabReportData[] = []
const puts: string[] = []
const deps: Partial<ReleaseDeps> = {
  render: async (d) => { rendered.push(d); return BYTES },
  putBlob: async (path) => { puts.push(path); return { url: `https://blob.test/${path}` } },
  now: () => NOW,
}

async function makePatient(): Promise<string> {
  const id = `TEST-SP5-${RUN}-R${++seq}`
  await getDb().insert(patients).values({ id, name: `TEST_SP5 Report ${seq}`, dob: '1980-08-02', gender: 'female' })
  patientIds.push(id)
  return id
}

async function makeRequisition(opts: { followUp?: { value: number; unit: 'days' | 'weeks' | 'months'; reason?: string }; provider?: number } = {}) {
  const patientId = await makePatient()
  const [req] = await getDb().insert(labRequisitions).values({
    patientId,
    orderedByProviderId: opts.provider ?? providerId,
    followUpRequested: !!opts.followUp,
    followUpIntervalValue: opts.followUp?.value ?? null,
    followUpIntervalUnit: opts.followUp?.unit ?? null,
    followUpReason: opts.followUp?.reason ?? null,
    createdByName: PROBE,
  }).returning()
  return req
}

/** An order on the requisition at `status`; resulted and later stages get a result by `enterer`. */
async function makeOrder(req: { id: number; patientId: string; orderedByProviderId: number }, testIndex: number, status: 'received' | 'resulted' | 'verified') {
  const db = getDb()
  const [o] = await db.insert(labOrders).values({
    patientId: req.patientId, labTestId: testIds[testIndex], orderedByProviderId: req.orderedByProviderId, requisitionId: req.id,
    status: status === 'verified' ? 'resulted' : status, collectedAt: new Date('2099-08-01T02:00:00Z'), receivedAt: new Date('2099-08-01T03:00:00Z'),
  }).returning()
  if (status !== 'received') {
    await db.insert(labResults).values({ labOrderId: o.id, value: `${5 + testIndex}.1`, unit: 'mmol/L', flag: 'normal', resultedByName: 'TEST_SP5 enterer', resultedByUserId: enterer })
  }
  if (status === 'verified') await verify(o.id)
  return o
}

async function verify(orderId: number) {
  const r = await verifyLabResult(orderId, VERIFIER, NOW)
  if (!r.ok) throw new Error(`fixture verify failed: ${r.error}`)
}

async function toResulted(orderId: number) {
  await getDb().update(labOrders).set({ status: 'resulted' }).where(eq(labOrders.id, orderId))
  await getDb().insert(labResults).values({ labOrderId: orderId, value: '1.0', flag: 'normal', resultedByName: 'TEST_SP5 enterer', resultedByUserId: enterer })
}

const statusOf = async (id: number) => (await getDb().select({ s: labOrders.status }).from(labOrders).where(eq(labOrders.id, id)))[0].s
const reportsOf = (requisitionId: number) => getDb().select().from(labReports).where(eq(labReports.requisitionId, requisitionId))
const reqRow = async (id: number) => (await getDb().select().from(labRequisitions).where(eq(labRequisitions.id, id)))[0]

describe.skipIf(!process.env.DATABASE_URL)('lab report release (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [pr, inactive] = await db.insert(providers).values([
      { name: `TEST_SP5 Dr Report ${RUN}`, specialty: 'Medicine', colorTag: '#000000', registrationCouncil: 'smc', registrationStateCode: 'KA', registrationNumber: '12345' },
      { name: `TEST_SP5 Dr Gone ${RUN}`, specialty: 'Medicine', colorTag: '#000000', isActive: false },
    ]).returning()
    providerId = pr.id
    inactiveProviderId = inactive.id
    const ts = await db.insert(labTests).values([0, 1, 2].map((i) => ({ name: `TEST_SP5 report test ${i} ${RUN}`, code: `TEST-SP5-R${i}-${RUN}`, referenceRange: '4-6' }))).returning()
    testIds.push(...ts.map((t) => t.id))
    const [a, b] = await db.insert(users).values([
      { name: `TEST_SP5_REPORT_E-${RUN}`, email: `test-sp5-re-${RUN}@example.invalid`, role: 'labs' },
      { name: PROBE_VERIFIER, email: `test-sp5-rv-${RUN}@example.invalid`, role: 'pi' },
    ]).returning()
    enterer = a.id
    verifierId = b.id
    VERIFIER = { role: 'pi', name: PROBE_VERIFIER, userId: verifierId }
  })

  afterAll(async () => {
    const db = getDb()
    if (patientIds.length > 0) {
      await db.delete(labReports).where(inArray(labReports.patientId, patientIds))
      const orderIds = (await db.select({ id: labOrders.id }).from(labOrders).where(inArray(labOrders.patientId, patientIds))).map((o) => o.id)
      if (orderIds.length > 0) await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.patientId, patientIds))
      await db.delete(labRequisitions).where(inArray(labRequisitions.patientId, patientIds))
      await db.delete(followUpOrders).where(inArray(followUpOrders.patientId, patientIds))
      await db.delete(auditLog).where(inArray(auditLog.patientId, patientIds))
      await db.delete(patients).where(inArray(patients.id, patientIds))
    }
    await db.delete(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    await db.delete(users).where(inArray(users.id, [enterer, verifierId]))
    if (testIds.length > 0) await db.delete(labTests).where(inArray(labTests.id, testIds))
    await db.delete(providers).where(inArray(providers.id, [providerId, inactiveProviderId]))
  }, 60_000)

  it('releases a report of the verified orders, marks them reported, versions it', async () => {
    const req = await makeRequisition()
    const o1 = await makeOrder(req, 0, 'verified')
    const o2 = await makeOrder(req, 1, 'verified')
    rendered.length = 0; puts.length = 0
    const r = await releaseLabReport(req.id, S, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.report).toMatchObject({ version: 1, supersededAt: null, requisitionId: req.id, patientId: req.patientId, orderIds: [o1.id, o2.id], releasedByName: PROBE })
    expect(r.report.reportNumber).toMatch(/^LR-2099-\d{6}$/)
    expect(r.report.releasedAt.getTime()).toBe(NOW.getTime())
    expect(r.report.byteSize).toBe(BYTES.length)
    expect(r.report.sha256).toBe(createHash('sha256').update(BYTES).digest('hex'))
    expect(r.report.testSummary).toBe(`TEST_SP5 report test 0 ${RUN}, TEST_SP5 report test 1 ${RUN}`)
    expect(puts).toHaveLength(1)
    expect(puts[0].startsWith(`lab-reports/${req.id}/${r.report.reportNumber}-`)).toBe(true)
    expect(puts[0].endsWith('.pdf')).toBe(true)
    expect(r.report.blobUrl).toBe(`https://blob.test/${puts[0]}`)
    expect(r.followUp).toEqual({ outcome: 'not_requested', followUpOrderId: null, dueDate: null })

    // The renderer got the report's own number and version, the verified rows, IST age and SMC registration.
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ reportNumber: r.report.reportNumber, version: 1, referringDoctor: { registration: 'SMC KA 12345' } })
    expect(rendered[0].patient).toMatchObject({ patientId: req.patientId, ageYears: 118, gender: 'Female' })
    expect(rendered[0].rows.map((x) => x.testName)).toEqual([`TEST_SP5 report test 0 ${RUN}`, `TEST_SP5 report test 1 ${RUN}`])
    expect(rendered[0].verifiers).toEqual([PROBE_VERIFIER])

    for (const id of [o1.id, o2.id]) {
      const [o] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
      expect(o.status).toBe('reported')
      expect(o.reportedAt?.getTime()).toBe(NOW.getTime())
      expect(o.statusChangedAt?.getTime()).toBe(NOW.getTime())
    }
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'released lab report')))
    expect(audits.filter((a) => a.details === `report=${r.report.id} requisition=${req.id} version=1 orders=${o1.id},${o2.id}`)).toHaveLength(1)
    expect(audits.find((a) => a.details?.startsWith(`report=${r.report.id} `))?.patientId).toBe(req.patientId)

    expect(await getLabReportForDownload(r.report.id)).toEqual({
      id: r.report.id, patientId: req.patientId, reportNumber: r.report.reportNumber, blobUrl: r.report.blobUrl, supersededAt: null,
    })
    expect(await getLabReportForDownload(2_000_000_000)).toBeNull()
  })

  it('a second release (after another order is verified) supersedes v1 with a cumulative v2', async () => {
    const req = await makeRequisition()
    const o1 = await makeOrder(req, 0, 'verified')
    const o2 = await makeOrder(req, 1, 'resulted')
    const v1 = await releaseLabReport(req.id, S, deps)
    expect(v1.ok && v1.report.orderIds).toEqual([o1.id])
    expect(v1.ok && v1.followUp.outcome).toBe('not_requested')
    await verify(o2.id)
    const v2 = await releaseLabReport(req.id, S, deps)
    expect(v2.ok).toBe(true)
    if (!v1.ok || !v2.ok) return
    expect(v2.report).toMatchObject({ version: 2, orderIds: [o1.id, o2.id], supersededAt: null })
    expect(v2.report.reportNumber).not.toBe(v1.report.reportNumber)
    const rows = await reportsOf(req.id)
    expect(rows.find((x) => x.id === v1.report.id)?.supersededAt?.getTime()).toBe(NOW.getTime())

    const portal = await listPortalLabReports(req.patientId)
    expect(portal.map((x) => x.id)).toEqual([v2.report.id])
    expect(Object.keys(portal[0]).sort()).toEqual(['id', 'releasedAt', 'reportNumber', 'testSummary'])
    const staff = await listReportsForPatient(req.patientId)
    expect(staff.map((x) => x.id)).toEqual([v2.report.id, v1.report.id])
    expect(staff[1].supersededAt?.getTime()).toBe(NOW.getTime())
    expect(Object.keys(staff[0]).sort()).toEqual(['id', 'releasedAt', 'reportNumber', 'supersededAt', 'testSummary', 'version'])
  })

  it('a change between render and commit is stale and writes nothing', async () => {
    const req = await makeRequisition()
    const o1 = await makeOrder(req, 0, 'verified')
    const o2 = await makeOrder(req, 1, 'verified')
    const o3 = await makeOrder(req, 2, 'resulted')
    const r = await releaseLabReport(req.id, S, { ...deps, render: async () => { await verify(o3.id); return new Uint8Array([1]) } })
    expect(r).toEqual({ ok: false, error: 'stale' })
    expect(await reportsOf(req.id)).toHaveLength(0)
    expect([await statusOf(o1.id), await statusOf(o2.id), await statusOf(o3.id)]).toEqual(['verified', 'verified', 'verified'])
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'released lab report'), eq(auditLog.patientId, req.patientId)))
    expect(audits).toHaveLength(0)
  })

  it('an amendment between render and commit is stale too', async () => {
    const req = await makeRequisition()
    await makeOrder(req, 0, 'verified')
    const r = await releaseLabReport(req.id, S, {
      ...deps,
      render: async () => {
        // Simulates a correction landing while the PDF renders (the amendedAt stamp changes).
        const [o] = await getDb().select({ id: labOrders.id }).from(labOrders).where(eq(labOrders.requisitionId, req.id))
        await getDb().update(labResults).set({ amendedAt: new Date('2099-08-01T04:59:00Z') }).where(eq(labResults.labOrderId, o.id))
        return BYTES
      },
    })
    expect(r).toEqual({ ok: false, error: 'stale' })
    expect(await reportsOf(req.id)).toHaveLength(0)
  })

  it('two releases of the same requisition at once: exactly one wins, the other is stale', async () => {
    const req = await makeRequisition()
    await makeOrder(req, 0, 'verified')
    await makeOrder(req, 1, 'verified')
    // Both snapshots are taken before either commits: each render waits until both have rendered.
    let arrived = 0
    let release: () => void = () => undefined
    const both = new Promise<void>((resolve) => { release = resolve })
    const barrier: Partial<ReleaseDeps> = { ...deps, render: async () => { arrived += 1; if (arrived === 2) release(); await both; return BYTES } }
    const rs = await Promise.all([releaseLabReport(req.id, S, barrier), releaseLabReport(req.id, S, barrier)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'stale' }])
    expect(await reportsOf(req.id)).toHaveLength(1)
  })

  it('nothing verified -> nothing_to_report; unknown requisition -> not_found; nothing rendered', async () => {
    const req = await makeRequisition()
    await makeOrder(req, 0, 'resulted')
    rendered.length = 0
    expect(await releaseLabReport(req.id, S, deps)).toEqual({ ok: false, error: 'nothing_to_report' })
    expect(await releaseLabReport(2_000_000_000, S, deps)).toEqual({ ok: false, error: 'not_found' })
    expect(rendered).toHaveLength(0)
  })

  it('creates a lab_report follow-up once every test is reported, due = today + interval', async () => {
    const req = await makeRequisition({ followUp: { value: 2, unit: 'weeks', reason: 'Review HbA1c' } })
    await makeOrder(req, 0, 'verified')
    const last = await makeOrder(req, 1, 'verified')
    const r = await releaseLabReport(req.id, S, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.followUp.outcome).toBe('created')
    expect(r.followUp.dueDate).toBe('2099-08-15')
    const [fu] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.patientId, req.patientId))
    expect(fu).toMatchObject({ id: r.followUp.followUpOrderId, source: 'lab_report', status: 'planned', originatingLabOrderId: last.id, prescribedByProviderId: providerId, reason: 'Review HbA1c', dueDate: '2099-08-15', baseDate: '2099-08-01' })
    const row = await reqRow(req.id)
    expect(row).toMatchObject({ followUpOutcome: 'created', followUpOrderId: fu.id })
    expect(row.followUpResolvedAt?.getTime()).toBe(NOW.getTime())
  })

  it('is pending while a test is still at the bench, and never creates twice', async () => {
    const req = await makeRequisition({ followUp: { value: 10, unit: 'days' } })
    await makeOrder(req, 0, 'verified')
    const bench = await makeOrder(req, 1, 'received')
    const first = await releaseLabReport(req.id, S, deps)
    expect(first.ok && first.followUp).toEqual({ outcome: 'pending', followUpOrderId: null, dueDate: null })
    expect((await reqRow(req.id)).followUpResolvedAt).toBeNull()

    await toResulted(bench.id)
    await verify(bench.id)
    const second = await releaseLabReport(req.id, S, deps)
    expect(second.ok && second.followUp.outcome).toBe('created')
    expect(second.ok && second.followUp.dueDate).toBe('2099-08-11')

    const extra = await makeOrder(req, 2, 'verified')
    const third = await releaseLabReport(req.id, S, deps)
    expect(third.ok && third.followUp).toEqual({ outcome: 'already_resolved', followUpOrderId: null, dueDate: null })
    expect(third.ok && third.report.orderIds).toContain(extra.id)
    const fus = await getDb().select().from(followUpOrders).where(eq(followUpOrders.patientId, req.patientId))
    expect(fus).toHaveLength(1)
    expect(fus[0].reason).toBe('Review of lab results')
  })

  it('links an existing open follow-up from the same doctor instead of creating one', async () => {
    const req = await makeRequisition({ followUp: { value: 1, unit: 'months' } })
    const [open] = await getDb().insert(followUpOrders).values({
      patientId: req.patientId, source: 'encounter', status: 'planned', prescribedByProviderId: providerId, baseDate: '2099-07-20',
      dueDate: '2099-08-10', windowStart: '2099-08-07', windowEnd: '2099-08-17', reason: 'Review', createdByName: PROBE,
    }).returning()
    const o = await makeOrder(req, 0, 'verified')
    const r = await releaseLabReport(req.id, S, deps)
    expect(r.ok && r.followUp).toEqual({ outcome: 'linked', followUpOrderId: open.id, dueDate: '2099-08-10' })
    const fus = await getDb().select().from(followUpOrders).where(eq(followUpOrders.patientId, req.patientId))
    expect(fus).toHaveLength(1)
    expect(fus[0].originatingLabOrderId).toBe(o.id)
    expect(await reqRow(req.id)).toMatchObject({ followUpOutcome: 'linked', followUpOrderId: open.id })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'linked lab report to follow-up'), eq(auditLog.patientId, req.patientId)))
    expect(audits.map((a) => a.details)).toEqual([`followUp=${open.id} requisition=${req.id}`])
  })

  it('an inactive prescriber yields failed but the report is still released', async () => {
    const req = await makeRequisition({ followUp: { value: 2, unit: 'weeks' }, provider: inactiveProviderId })
    const o = await makeOrder(req, 0, 'verified')
    const r = await releaseLabReport(req.id, S, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.followUp).toEqual({ outcome: 'failed', followUpOrderId: null, dueDate: null })
    expect(await statusOf(o.id)).toBe('reported')
    expect(await reportsOf(req.id)).toHaveLength(1)
    expect(await reqRow(req.id)).toMatchObject({ followUpOutcome: 'failed', followUpOrderId: null })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'lab follow-up not created'), eq(auditLog.patientId, req.patientId)))
    expect(audits.map((a) => a.details)).toEqual([`requisition=${req.id} error=provider_not_found`])
  })
})
