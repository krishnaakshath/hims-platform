import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'

// WS2 T10: lab/imaging orders carry priority, clinical notes and fasting, and each order is billed
// at order time through the auto-charge seam (one lab_order line per order, priced by the same
// resolver call as the quote). Real DB. Query-level checks pin `now` to 2099 (fixtures never meet
// real data; finalised invoices number in the test-only 2099-00 year); the route checks use today.
let role = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'TEST-WS2T10 route', userId: null })) }))
let routeProviderId = 0
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => (routeProviderId ? { id: routeProviderId } : null)) }))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))

const NOW = new Date('2099-07-01T06:00:00Z') // 11:30 IST
const LATER = new Date('2099-07-01T09:00:00Z')
const DAY = '2099-07-01'

describe.skipIf(!process.env.DATABASE_URL)('lab orders billed at order time (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const CODE = `TW10${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const PIN = `9${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`
  const doctor: Session = { role: 'admin', name: `TEST-WS2T10-${RUN}-dr`, userId: null }
  const billing: Session = { role: 'billing', name: `TEST-WS2T10-${RUN}-billing`, userId: null }
  const fx = { dep: 0, prov: 0, prov2: 0, svcA: 0, svcB: 0, svcImg: 0, payerId: 0, tA: 0, tB: 0, tFast: 0, tImg: 0, pinId: 0, rateIds: [] as number[] }
  const PIDS: string[] = []
  let savedSettings: Record<string, unknown> | null = null
  let seq = 0

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    req: await import('@/lib/queries/lab-requisitions'),
    life: await import('@/lib/queries/lab-lifecycle'),
    lo: await import('@/lib/queries/lab-orders'),
    enc: await import('@/lib/queries/encounters'),
    inv: await import('@/lib/queries/invoices'),
    india: await import('@/lib/india-time'),
  })

  async function newPatient(over: Record<string, unknown> = {}): Promise<string> {
    const { getDb, patients } = await m()
    const id = `TEST-WS2T10-${RUN}-${++seq}`
    PIDS.push(id)
    await getDb().insert(patients).values({ id, name: `Test WS2T10 ${seq}`, dob: '1990-01-01', uhid: `${CODE}${seq}`, stateCode: 'IN-KA', addressLine1: '1 Test Street', phone: '9999999999', ...over } as never)
    return id
  }

  async function opdEncounter(patientId: string, over: Record<string, unknown> = {}) {
    const { getDb, encounters } = await m()
    const [e] = await getDb().insert(encounters).values({
      patientId, encounterType: 'opd', encounterDate: DAY, providerId: fx.prov, departmentId: fx.dep, checkedInByName: doctor.name, ...over,
    } as never).returning()
    return e
  }

  async function order(over: Record<string, unknown> = {}, now = NOW) {
    const { req } = await m()
    const r = await req.createLabRequisition({
      patientId: '', orderedByProviderId: fx.prov, labTestIds: [fx.tA, fx.tB], followUp: null, originatingEncounterId: null,
      priority: 'routine', clinicalNotes: null, fastingRequired: null, ...over,
    } as never, doctor, now)
    if (!r.ok) throw new Error(`order failed: ${r.error}`)
    return r
  }

  async function linesOf(patientId: string) {
    const { getDb, chargeLines, eq, asc } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.patientId, patientId)).orderBy(asc(chargeLines.id))
  }

  async function ordersOf(requisitionId: number) {
    const { getDb, labOrders, eq, asc } = await m()
    return getDb().select().from(labOrders).where(eq(labOrders.requisitionId, requisitionId)).orderBy(asc(labOrders.id))
  }

  beforeAll(async () => {
    const { getDb, departments, providers, serviceCatalog, payers, billingSettings, tariffRates, labTests, labServiceAreaPins, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    const [dep] = await db.insert(departments).values({ code: `${CODE}D`, name: `Test WS2T10 ${RUN}` }).returning()
    fx.dep = dep.id
    const prov = async (name: string) => (await db.insert(providers).values({ name, specialty: 'Test', colorTag: '#000000', departmentId: dep.id }).returning())[0].id
    fx.prov = await prov(`TEST-WS2T10 Dr A ${RUN}`)
    fx.prov2 = await prov(`TEST-WS2T10 Dr B ${RUN}`)
    const svc = async (suffix: string, category: 'investigation_lab' | 'investigation_imaging') =>
      (await db.insert(serviceCatalog).values({ code: `${CODE}${suffix}`, name: `Test ${suffix}`, departmentId: dep.id, category, hsnSac: '999316', gstRateBp: 0 }).returning())[0].id
    fx.svcA = await svc('A', 'investigation_lab')
    fx.svcB = await svc('B', 'investigation_lab')
    fx.svcImg = await svc('I', 'investigation_imaging')
    const [payer] = await db.insert(payers).values({ name: `Test WS2T10 Payer ${RUN}`, payerId: CODE }).returning()
    fx.payerId = payer.id
    const rates = await db.insert(tariffRates).values([
      { serviceId: fx.svcA, scope: 'base', amountPaise: 45000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T10' },
      { serviceId: fx.svcA, scope: 'payer', payerId: payer.id, amountPaise: 38000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T10' },
      { serviceId: fx.svcB, scope: 'base', amountPaise: 20000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T10' },
      { serviceId: fx.svcImg, scope: 'base', amountPaise: 90000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T10' },
    ]).returning()
    fx.rateIds.push(...rates.map((r) => r.id))
    const tests = await db.insert(labTests).values([
      { name: `Test WS2T10 A ${RUN}`, code: `${CODE}-A`, serviceId: fx.svcA },
      { name: `Test WS2T10 B ${RUN}`, code: `${CODE}-B`, serviceId: fx.svcB },
      { name: `Test WS2T10 fasting ${RUN}`, code: `${CODE}-F`, serviceId: fx.svcB, fastingRequired: true },
      { name: `Test WS2T10 imaging ${RUN}`, code: `${CODE}-I`, serviceId: fx.svcImg, category: 'imaging' },
    ] as never).returning()
    ;[fx.tA, fx.tB, fx.tFast, fx.tImg] = tests.map((t) => t.id)
    const [pin] = await db.insert(labServiceAreaPins).values({ pinCode: PIN, createdByName: 'TEST-WS2T10' }).returning()
    fx.pinId = pin.id
    await db.update(billingSettings).set({ legalName: 'Test WS2T10 Hospital', stateCode: 'IN-KA', gstin: null, placeOfSupplyMode: 'location_of_service' }).where(eq(billingSettings.id, 1))
  })

  async function purgeOrders() {
    const { getDb, labOrders, labRequisitions, encounters, admissions, inArray } = await m()
    const { purgeBillingFixtures } = await import('../db/billing-fixtures')
    await purgeBillingFixtures([...PIDS])
    if (PIDS.length === 0) return
    const db = getDb()
    await db.delete(labOrders).where(inArray(labOrders.patientId, PIDS))
    await db.delete(labRequisitions).where(inArray(labRequisitions.patientId, PIDS))
    await db.delete(encounters).where(inArray(encounters.patientId, PIDS))
    await db.delete(admissions).where(inArray(admissions.patientId, PIDS))
  }

  afterEach(async () => {
    role = 'admin'
    routeProviderId = 0
    await purgeOrders()
  })

  afterAll(async () => {
    const { getDb, departments, providers, serviceCatalog, tariffRates, patients, payers, billingSettings, auditLog, labTests, labServiceAreaPins, eq, inArray, or } = await m()
    const db = getDb()
    await purgeOrders()
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    if (PIDS.length) {
      await db.delete(auditLog).where(or(inArray(auditLog.patientId, PIDS), inArray(auditLog.userName, [doctor.name, billing.name, 'TEST-WS2T10 route'])))
      await db.delete(patients).where(inArray(patients.id, PIDS))
    }
    await db.delete(labServiceAreaPins).where(eq(labServiceAreaPins.id, fx.pinId))
    await db.delete(labTests).where(inArray(labTests.id, [fx.tA, fx.tB, fx.tFast, fx.tImg]))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rateIds))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [fx.svcA, fx.svcB, fx.svcImg]))
    await db.delete(payers).where(eq(payers.id, fx.payerId))
    await db.delete(providers).where(inArray(providers.id, [fx.prov, fx.prov2]))
    await db.delete(departments).where(eq(departments.id, fx.dep))
  })

  it('an order of two tests from an OPD visit captures one lab_order line per order, priced as quoted, in the order transaction', async () => {
    const pid = await newPatient({ primaryPayerId: null })
    const e = await opdEncounter(pid)
    const r = await order({ patientId: pid, originatingEncounterId: e.id, priority: 'urgent', clinicalNotes: 'Rule out anaemia' })
    expect(r.requisition).toMatchObject({ priority: 'urgent', clinicalNotes: 'Rule out anaemia', fastingRequired: false, originatingEncounterId: e.id })
    const orders = await ordersOf(r.requisition.id)
    const lines = await linesOf(pid)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => [l.source, l.labOrderId, l.encounterId, l.admissionId, l.payerId, l.unitPricePaise, l.taxablePaise, l.quantity, l.serviceDate, l.status])).toEqual([
      ['lab_order', orders[0].id, e.id, null, null, 45000, 45000, 1, DAY, 'captured'],
      ['lab_order', orders[1].id, e.id, null, null, 20000, 20000, 1, DAY, 'captured'],
    ])
    expect(orders.map((o) => o.quotedPricePaise)).toEqual(lines.map((l) => l.unitPricePaise))
    expect(orders.map((o) => o.quotedTariffRateId)).toEqual(lines.map((l) => l.tariffRateId))
    expect(r.charges).toEqual([
      { ok: true, source: 'lab_order', lineId: lines[0].id, itemName: 'Test A', taxablePaise: 45000, billTo: 'self', existing: false },
      { ok: true, source: 'lab_order', lineId: lines[1].id, itemName: 'Test B', taxablePaise: 20000, billTo: 'self', existing: false },
    ])
  })

  // Fix round 1 (I2): each order is a distinct billable act; duplicate_charge does not apply to order lines.
  it('two same-day orders of the same test from one visit are two lines; a retry of one order is existing', async () => {
    const pid = await newPatient()
    const e = await opdEncounter(pid)
    const first = await order({ patientId: pid, originatingEncounterId: e.id, labTestIds: [fx.tA] })
    const second = await order({ patientId: pid, originatingEncounterId: e.id, labTestIds: [fx.tA] })
    expect(second.charges).toEqual([expect.objectContaining({ ok: true, existing: false, taxablePaise: 45000 })])
    const lines = await linesOf(pid)
    expect(lines.map((l) => [l.labOrderId, l.status])).toEqual([[first.lines[0].orderId, 'captured'], [second.lines[0].orderId, 'captured']])
    const { getDb } = await m()
    const ac = await import('@/lib/queries/auto-charge')
    const retry = await getDb().transaction((tx) => ac.captureAutoChargeInTx(tx, {
      context: { encounterId: e.id }, serviceId: fx.svcA, quantity: 1, serviceDate: DAY, source: 'lab_order', links: { labOrderId: first.lines[0].orderId },
    }, doctor, NOW))
    expect(retry).toMatchObject({ ok: true, lineId: lines[0].id, existing: true })
    expect(await linesOf(pid)).toHaveLength(2)
  })

  it('an OPD patient with a primary payer is quoted and billed self-pay (the quote follows the bill-to)', async () => {
    const pid = await newPatient({ primaryPayerId: fx.payerId })
    const e = await opdEncounter(pid)
    const r = await order({ patientId: pid, originatingEncounterId: e.id, labTestIds: [fx.tA] })
    expect(r.lines[0].quotedPricePaise).toBe(45000)
    expect((await linesOf(pid)).map((l) => [l.payerId, l.unitPricePaise])).toEqual([[null, 45000]])
  })

  it('an inpatient order bills the admission, to the primary payer at the payer rate', async () => {
    const pid = await newPatient({ primaryPayerId: fx.payerId })
    const { getDb, admissions } = await m()
    const [adm] = await getDb().insert(admissions).values({ patientId: pid, attendingProviderId: fx.prov, admittedAt: new Date('2099-06-30T06:00:00Z') }).returning()
    const r = await order({ patientId: pid, labTestIds: [fx.tA] })
    expect(r.lines[0].quotedPricePaise).toBe(38000)
    const [line] = await linesOf(pid)
    expect(line).toMatchObject({ source: 'lab_order', admissionId: adm.id, payerId: fx.payerId, unitPricePaise: 38000, labOrderId: r.lines[0].orderId })
    expect(r.charges).toEqual([expect.objectContaining({ ok: true, billTo: 'payer', taxablePaise: 38000 })])
  })

  it('an order with no visit and no stay is still created, with a no_context outcome', async () => {
    const pid = await newPatient()
    const r = await order({ patientId: pid })
    expect(r.charges).toEqual([
      { ok: false, source: 'lab_order', reason: 'no_context' },
      { ok: false, source: 'lab_order', reason: 'no_context' },
    ])
    expect(await linesOf(pid)).toEqual([])
    expect(await ordersOf(r.requisition.id)).toHaveLength(2)
  })

  it('the order form catalog carries each test\'s list price and fasting flag', async () => {
    const { listLabTests } = await import('@/lib/queries/lab-tests')
    const byId = new Map((await listLabTests()).map((t) => [t.id, t]))
    expect([byId.get(fx.tA)?.pricePaise, byId.get(fx.tA)?.fastingRequired]).toEqual([45000, false])
    expect([byId.get(fx.tFast)?.pricePaise, byId.get(fx.tFast)?.fastingRequired]).toEqual([20000, true])
    // A test mapped to a service with no rate is unpriced (the subqueries bind to the test's own service).
    const { getDb, serviceCatalog, labTests, eq } = await m()
    const [svc] = await getDb().insert(serviceCatalog).values({ code: `${CODE}N`, name: 'Test N', departmentId: fx.dep, category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0 }).returning()
    const [t] = await getDb().insert(labTests).values({ name: `Test WS2T10 norate ${RUN}`, code: `${CODE}-N`, serviceId: svc.id }).returning()
    try {
      const row = (await listLabTests()).find((x) => x.id === t.id)
      expect([row?.priced, row?.pricePaise]).toEqual([false, null])
    } finally {
      await getDb().delete(labTests).where(eq(labTests.id, t.id))
      await getDb().delete(serviceCatalog).where(eq(serviceCatalog.id, svc.id))
    }
  })

  it('fasting defaults from the tests and follows an explicit choice', async () => {
    const pid = await newPatient()
    expect((await order({ patientId: pid, labTestIds: [fx.tFast, fx.tA] })).requisition.fastingRequired).toBe(true)
    expect((await order({ patientId: pid, labTestIds: [fx.tFast], fastingRequired: false })).requisition.fastingRequired).toBe(false)
    expect((await order({ patientId: pid, labTestIds: [fx.tA] })).requisition.fastingRequired).toBe(false)
    expect((await order({ patientId: pid, labTestIds: [fx.tA], fastingRequired: true })).requisition.fastingRequired).toBe(true)
  })

  it('the worklist carries the priority and lists stat, then urgent, before routine', async () => {
    const pid = await newPatient()
    const routine = await order({ patientId: pid, labTestIds: [fx.tA] }, new Date('2099-07-01T05:00:00Z'))
    const stat = await order({ patientId: pid, labTestIds: [fx.tA], priority: 'stat' }, new Date('2099-07-01T04:00:00Z'))
    const urgent = await order({ patientId: pid, labTestIds: [fx.tA], priority: 'urgent' }, new Date('2099-07-01T06:00:00Z'))
    const { lo } = await m()
    const mine = (await lo.listWorklist()).filter((w) => w.patientId === pid)
    expect(mine.map((w) => [w.id, w.priority])).toEqual([
      [stat.lines[0].orderId, 'stat'], [urgent.lines[0].orderId, 'urgent'], [routine.lines[0].orderId, 'routine'],
    ])
  })

  describe('cancel', () => {
    it('cancelling a captured order voids its line (billing: voided); a draft invoice loses it', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await order({ patientId: pid, originatingEncounterId: e.id })
      const { inv, life, getDb, auditLog, eq } = await m()
      const [l0] = await linesOf(pid)
      const d = await inv.createDraftInvoice([l0.id], billing)
      expect(d.ok).toBe(true)
      const c = await life.cancelLabOrder(r.lines[0].orderId, 'Duplicate order', doctor, LATER)
      expect(c).toMatchObject({ ok: true, billing: 'voided' })
      const lines = await linesOf(pid)
      expect(lines.map((l) => [l.status, l.voidReason, l.invoiceId])).toEqual([['void', 'Lab order cancelled', null], ['captured', null, null]])
      const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
      expect(audits).toContain(`billing: voided charge line|line=${l0.id} order=${r.lines[0].orderId} cause=order_cancelled`)
    })

    it('an order with no line cancels with billing: none', async () => {
      const pid = await newPatient()
      const r = await order({ patientId: pid })
      const { life } = await m()
      expect(await life.cancelLabOrder(r.lines[0].orderId, 'x', doctor, LATER)).toMatchObject({ ok: true, billing: 'none' })
    })

    it('after a finalised invoice the order still cancels, the line is unchanged and billing is credit_note_needed (route 200)', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await order({ patientId: pid, originatingEncounterId: e.id, labTestIds: [fx.tA] })
      const { inv } = await m()
      const [line] = await linesOf(pid)
      const d = await inv.createDraftInvoice([line.id], billing)
      if (!d.ok) throw new Error(d.error)
      const f = await inv.finaliseInvoice(d.invoiceId, billing, NOW)
      if (!f.ok) throw new Error(f.error)
      role = 'pi'
      const { POST } = await import('@/app/api/lab-orders/[id]/cancel/route')
      const res = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Not needed' }) }) as never, { params: Promise.resolve({ id: String(r.lines[0].orderId) }) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, billing: 'credit_note_needed' })
      const [after] = await linesOf(pid)
      expect([after.status, after.invoiceId, after.voidReason]).toEqual(['invoiced', d.invoiceId, null])
    })
  })

  describe('visit cancel and lab lines', () => {
    it('cancelling the visit cancels its pending lab orders and voids their lines', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await order({ patientId: pid, originatingEncounterId: e.id })
      const { enc } = await m()
      const c = await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      expect(c.ok).toBe(true)
      expect((await linesOf(pid)).map((l) => [l.source, l.status, l.voidReason])).toEqual([
        ['lab_order', 'void', 'Visit cancelled'], ['lab_order', 'void', 'Visit cancelled'],
      ])
      // Fix round 1 (I1): the orders go with the visit, so no test is left active and unbilled.
      expect((await ordersOf(r.requisition.id)).map((o) => [o.status, o.cancelReason, o.cancelledByName])).toEqual([
        ['cancelled', 'Visit cancelled', doctor.name], ['cancelled', 'Visit cancelled', doctor.name],
      ])
    })

    it('a visit with a collected order cannot be cancelled (visit_has_performed_orders) and nothing changes', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await order({ patientId: pid, originatingEncounterId: e.id })
      const { enc, life, getDb, encounters, eq } = await m()
      const collected = await life.collectLabOrder(r.lines[0].orderId, doctor, NOW)
      expect(collected.ok).toBe(true)
      const c = await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      expect(c).toEqual({ ok: false, error: 'visit_has_performed_orders' })
      const [after] = await getDb().select().from(encounters).where(eq(encounters.id, e.id))
      expect([after.status, after.cancelReason]).toEqual(['checked_in', null])
      expect((await ordersOf(r.requisition.id)).map((o) => o.status)).toEqual(['collected', 'ordered'])
      expect((await linesOf(pid)).map((l) => l.status)).toEqual(['captured', 'captured'])
    })

    it('a lab line on a finalised invoice blocks the visit cancel (visit_billed) and changes nothing', async () => {
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      await order({ patientId: pid, originatingEncounterId: e.id })
      const { enc, inv, getDb, encounters, eq } = await m()
      const [l0] = await linesOf(pid)
      const d = await inv.createDraftInvoice([l0.id], billing)
      if (!d.ok) throw new Error(d.error)
      const f = await inv.finaliseInvoice(d.invoiceId, billing, NOW)
      if (!f.ok) throw new Error(f.error)
      const c = await enc.transitionEncounter(e.id, 'cancelled', doctor, { cancelReason: 'Left', now: LATER })
      expect(c).toEqual({ ok: false, error: 'visit_billed', invoiceNumber: f.invoiceNumber })
      expect((await linesOf(pid)).map((l) => l.status)).toEqual(['invoiced', 'captured'])
      const [after] = await getDb().select().from(encounters).where(eq(encounters.id, e.id))
      expect(after.status).toBe('checked_in')
    })
  })

  describe('routes', () => {
    const post = async (pid: string, body: unknown) => {
      const { POST } = await import('@/app/api/patients/[anonId]/lab-orders/route')
      return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ anonId: pid }) })
    }
    const today = async () => (await m()).india.todayIsoIn('Asia/Kolkata')

    it('no originatingEncounterId: the open OPD visit with the ordering doctor today is used; response has charges', async () => {
      routeProviderId = fx.prov
      const pid = await newPatient()
      await opdEncounter(pid, { encounterDate: await today(), providerId: fx.prov2 }) // another doctor's visit: not used
      const mine = await opdEncounter(pid, { encounterDate: await today(), status: 'in_consultation' })
      const res = await post(pid, { labTestIds: [fx.tA], priority: 'stat', clinicalNotes: '  Chest pain  ', fastingRequired: false })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.charges).toEqual([expect.objectContaining({ ok: true, source: 'lab_order', taxablePaise: 45000, billTo: 'self' })])
      expect(body.homeCollectionEligible).toBe(false) // no PIN on file
      const { getDb, labRequisitions, eq } = await m()
      const [rq] = await getDb().select().from(labRequisitions).where(eq(labRequisitions.id, body.requisitionId))
      expect(rq).toMatchObject({ originatingEncounterId: mine.id, priority: 'stat', clinicalNotes: 'Chest pain', fastingRequired: false })
      expect((await linesOf(pid))[0].encounterId).toBe(mine.id)
    })

    it('no visit and no stay: 201 with no_context outcomes; a completed visit today is not used', async () => {
      routeProviderId = fx.prov
      const pid = await newPatient()
      await opdEncounter(pid, { encounterDate: await today(), status: 'completed' })
      const res = await post(pid, { labTestIds: [fx.tA, fx.tB] })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.charges.map((c: { reason: string }) => c.reason)).toEqual(['no_context', 'no_context'])
    })

    it('homeCollectionEligible: local patient, a lab test, and a booking role', async () => {
      routeProviderId = fx.prov
      const pid = await newPatient({ pinCode: PIN })
      role = 'pi'
      const lab = await (await post(pid, { labTestIds: [fx.tA] })).json()
      expect(lab.homeCollectionEligible).toBe(true)
      const img = await (await post(pid, { labTestIds: [fx.tImg] })).json()
      expect(img.homeCollectionEligible).toBe(false)
    })

    it('rejects an unknown priority and over-long clinical notes (400)', async () => {
      routeProviderId = fx.prov
      const pid = await newPatient()
      expect((await post(pid, { labTestIds: [fx.tA], priority: 'asap' })).status).toBe(400)
      expect((await post(pid, { labTestIds: [fx.tA], clinicalNotes: 'x'.repeat(501) })).status).toBe(400)
    })

    it('a pi can book a home collection (role policy row from T1)', async () => {
      const { HOME_COLLECTION_BOOKING_ROLES } = await import('@/lib/role-policy')
      expect(HOME_COLLECTION_BOOKING_ROLES).toContain('pi')
      role = 'pi'
      const { POST } = await import('@/app/api/home-collections/route')
      const res = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({}) }) as never)
      expect(res.status).toBe(400) // past the role gate; the empty body is refused
    })

    it('GET ?encounterId: the visit\'s orders with status, price and billing state', async () => {
      routeProviderId = fx.prov
      const pid = await newPatient()
      const e = await opdEncounter(pid)
      const r = await order({ patientId: pid, originatingEncounterId: e.id, priority: 'urgent' })
      const { life } = await m()
      await life.cancelLabOrder(r.lines[1].orderId, 'x', doctor, LATER)
      const { GET } = await import('@/app/api/patients/[anonId]/lab-orders/route')
      const res = await GET(new Request(`http://localhost/api/patients/${pid}/lab-orders?encounterId=${e.id}`) as never, { params: Promise.resolve({ anonId: pid }) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.billTo).toBe('self')
      expect(body.orders).toEqual([
        expect.objectContaining({ id: r.lines[0].orderId, testName: `Test WS2T10 A ${RUN}`, category: 'lab', status: 'ordered', priority: 'urgent', quotedPricePaise: 45000, billing: 'billed' }),
        expect.objectContaining({ id: r.lines[1].orderId, status: 'cancelled', quotedPricePaise: 20000, billing: 'void' }),
      ])
      role = 'labs'
      expect((await GET(new Request(`http://localhost/x?encounterId=${e.id}`) as never, { params: Promise.resolve({ anonId: pid }) })).status).toBe(403)
      role = 'admin'
      expect((await GET(new Request('http://localhost/x?encounterId=abc') as never, { params: Promise.resolve({ anonId: pid }) })).status).toBe(400)
      expect((await GET(new Request('http://localhost/x?encounterId=2147483000') as never, { params: Promise.resolve({ anonId: pid }) })).status).toBe(404)
    })
  })
})
