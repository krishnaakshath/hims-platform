import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'
import type { getDb } from '@/db/client'

type Db = ReturnType<typeof getDb>

// WS2 T12: "Invoice all ready lines" (drafts for every ready group, spec ruling 12) and "Orders not
// billed". Real DB. Every create call is scoped to this file's patients (a global run would draft
// other fixtures' lines); the global preview is read-only. Query-level checks pin `now` to 2099.
let role = 'billing'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role, name: 'TEST-WS2T12 route', userId: null })) }
})
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))

const NOW = new Date('2099-07-01T06:00:00Z') // 11:30 IST
const DAY = '2099-07-01'

describe.skipIf(!process.env.DATABASE_URL)('invoice all ready lines; orders not billed (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const CODE = `TW12${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const doctor: Session = { role: 'admin', name: `TEST-WS2T12-${RUN}-dr`, userId: null }
  const billing: Session = { role: 'billing', name: `TEST-WS2T12-${RUN}-billing`, userId: null }
  const fx = { dep: 0, prov: 0, consult: 0, lab: 0, proc: 0, test: 0, med: 0, rateIds: [] as number[] }
  const PIDS: string[] = []
  let savedSettings: Record<string, unknown> | null = null
  let seq = 0

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    ir: await import('@/lib/queries/invoice-ready'),
    req: await import('@/lib/queries/lab-requisitions'),
    enc: await import('@/lib/queries/encounters'),
    kpi: await import('@/lib/queries/hospital-kpis'),
    route: await import('@/app/api/billing/invoice-ready/route'),
  })

  async function newPatient(over: Record<string, unknown> = {}): Promise<string> {
    const { getDb, patients } = await m()
    const id = `TEST-WS2T12-${RUN}-${++seq}`
    PIDS.push(id)
    await getDb().insert(patients).values({ id, name: `Test WS2T12 ${seq}`, dob: '1990-01-01', uhid: `${CODE}${seq}`, stateCode: 'IN-KA', phone: '9999999999', primaryPayerId: null, ...over } as never)
    return id
  }

  async function encounter(patientId: string, over: Record<string, unknown> = {}) {
    const { getDb, encounters } = await m()
    const [e] = await getDb().insert(encounters).values({
      patientId, encounterType: 'opd', encounterDate: DAY, providerId: fx.prov, departmentId: fx.dep, checkedInByName: doctor.name, ...over,
    } as never).returning()
    return e
  }

  /** A pharmacy line as the pharmacy stream writes it (that stream merges later). */
  async function pharmacyLine(patientId: string, encounterId: number | null, taxablePaise = 2000) {
    const { getDb, medicationDispenses, chargeLines } = await m()
    const db = getDb()
    const [d] = await db.insert(medicationDispenses).values({ patientId, medicationId: fx.med, quantity: 2, dispensedByName: 'TEST-WS2T12' }).returning()
    const [l] = await db.insert(chargeLines).values({
      patientId, encounterId, source: 'pharmacy', itemCode: 'PHX', itemName: 'Test drug', serviceDate: DAY, quantity: 2, unitPricePaise: taxablePaise / 2,
      priceSource: 'pharmacy', taxablePaise, gstRateBp: 1200, hsnSac: '30049099', createdByName: 'TEST-WS2T12', medicationDispenseId: d.id,
    } as never).returning()
    return l
  }

  async function labOrder(patientId: string, originatingEncounterId: number | null) {
    const { req } = await m()
    const r = await req.createLabRequisition({
      patientId, orderedByProviderId: fx.prov, labTestIds: [fx.test], followUp: null, originatingEncounterId, priority: 'routine', clinicalNotes: null, fastingRequired: null,
    } as never, doctor, NOW)
    if (!r.ok) throw new Error(`order failed: ${r.error}`)
    return r
  }

  async function linesOf(patientId: string) {
    const { getDb, chargeLines, eq, asc } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.patientId, patientId)).orderBy(asc(chargeLines.id))
  }

  const post = async (body: unknown) => {
    const { route } = await m()
    return route.POST(new Request('http://localhost/api/billing/invoice-ready', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) as never)
  }
  const get = async (qs: string) => {
    const { route } = await m()
    return route.GET(new Request(`http://localhost/api/billing/invoice-ready${qs}`) as never)
  }

  /** Runs `during` inside a transaction holding the patient's billing lock, once `blocked` waits on it. */
  async function whileBillingLocked<T>(patientId: string, blocked: () => Promise<T>, during: (tx: unknown) => Promise<void>): Promise<T> {
    const { getDb, sql } = await m()
    const db = getDb()
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    let held!: () => void
    const holding = new Promise<void>((res) => { held = res })
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:patient:${patientId}`}))`)
      held()
      await gate
      await during(tx)
    })
    await holding
    const p = blocked()
    for (let i = 0; i < 200; i++) {
      const res = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`)
      if (Number((res as unknown as { rows: { n: number }[] }).rows[0].n) > 0) break
      await new Promise((res) => setTimeout(res, 25))
    }
    release()
    await holder
    return p
  }

  beforeAll(async () => {
    const { getDb, departments, providers, serviceCatalog, billingSettings, tariffRates, labTests, medications, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    const [dep] = await db.insert(departments).values({ code: `${CODE}D`, name: `Test WS2T12 ${RUN}` }).returning()
    fx.dep = dep.id
    fx.prov = (await db.insert(providers).values({ name: `TEST-WS2T12 Dr ${RUN}`, specialty: 'Test', colorTag: '#000000', departmentId: dep.id }).returning())[0].id
    const svc = async (suffix: string, category: 'consultation' | 'investigation_lab' | 'procedure') =>
      (await db.insert(serviceCatalog).values({ code: `${CODE}${suffix}`, name: `Test WS2T12 ${suffix}`, departmentId: dep.id, category, hsnSac: '999312', gstRateBp: 0 }).returning())[0].id
    fx.consult = await svc('C', 'consultation')
    fx.lab = await svc('L', 'investigation_lab')
    fx.proc = await svc('P', 'procedure')
    const rates = await db.insert(tariffRates).values([
      { serviceId: fx.consult, scope: 'base', amountPaise: 50000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T12' },
      { serviceId: fx.lab, scope: 'base', amountPaise: 45000, validFrom: '2020-01-01', createdByName: 'TEST-WS2T12' },
    ]).returning()
    fx.rateIds.push(...rates.map((r) => r.id))
    fx.test = (await db.insert(labTests).values({ name: `Test WS2T12 CBC ${RUN}`, code: `${CODE}-T`, serviceId: fx.lab } as never).returning())[0].id
    fx.med = (await db.insert(medications).values({ name: `Test WS2T12 drug ${RUN}`, medicationClass: 'Test' }).returning())[0].id
    await db.update(billingSettings).set({ legalName: 'Test WS2T12 Hospital', stateCode: 'IN-KA', gstin: null, placeOfSupplyMode: 'location_of_service', freeReviewDays: 0 }).where(eq(billingSettings.id, 1))
  })

  async function purge() {
    const { getDb, labOrders, labRequisitions, encounterProcedures, encounters, admissions, medicationDispenses, inArray } = await m()
    const { purgeBillingFixtures } = await import('../db/billing-fixtures')
    await purgeBillingFixtures([...PIDS])
    if (PIDS.length === 0) return
    const db = getDb()
    await db.delete(labOrders).where(inArray(labOrders.patientId, PIDS))
    await db.delete(labRequisitions).where(inArray(labRequisitions.patientId, PIDS))
    await db.delete(medicationDispenses).where(inArray(medicationDispenses.patientId, PIDS))
    await db.delete(encounterProcedures).where(inArray(encounterProcedures.patientId, PIDS))
    await db.delete(encounters).where(inArray(encounters.patientId, PIDS))
    await db.delete(admissions).where(inArray(admissions.patientId, PIDS))
  }

  afterEach(async () => {
    role = 'billing'
    await purge()
  })

  afterAll(async () => {
    const { getDb, departments, providers, serviceCatalog, tariffRates, patients, billingSettings, auditLog, labTests, medications, eq, inArray, or } = await m()
    const db = getDb()
    await purge()
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db.delete(auditLog).where(or(inArray(auditLog.userName, [doctor.name, billing.name, 'TEST-WS2T12 route']), PIDS.length ? inArray(auditLog.patientId, PIDS) : undefined))
    if (PIDS.length) await db.delete(patients).where(inArray(patients.id, PIDS))
    await db.delete(labTests).where(eq(labTests.id, fx.test))
    await db.delete(medications).where(eq(medications.id, fx.med))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rateIds))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [fx.consult, fx.lab, fx.proc]))
    await db.delete(providers).where(eq(providers.id, fx.prov))
    await db.delete(departments).where(eq(departments.id, fx.dep))
  })

  it('B5 pin, then one draft: a completed visit\'s consultation, lab and pharmacy lines stay uninvoiced until the action runs, which drafts all three on one invoice', async () => {
    const pid = await newPatient()
    const e = await encounter(pid)
    await labOrder(pid, e.id)
    await pharmacyLine(pid, e.id, 3000)
    const { ir, enc, getDb, invoices, auditLog, eq, and } = await m()
    // While the visit is open, its lines wait.
    expect(await ir.previewInvoiceReady({ patientId: pid })).toEqual({ groups: 0, lines: 0, taxablePaise: 0, waitingLines: 2 })
    const done = await enc.transitionEncounter(e.id, 'completed', doctor, { now: NOW })
    expect(done.ok).toBe(true)
    // B5: completing the visit invoices nothing; every line is still captured, on no invoice.
    const before = await linesOf(pid)
    expect(before.map((l) => [l.source, l.status, l.invoiceId, l.encounterId])).toEqual([
      ['lab_order', 'captured', null, e.id], ['pharmacy', 'captured', null, e.id], ['consultation', 'captured', null, e.id],
    ])
    expect(await getDb().select().from(invoices).where(eq(invoices.patientId, pid))).toEqual([])
    expect(await ir.previewInvoiceReady({ patientId: pid })).toEqual({ groups: 1, lines: 3, taxablePaise: 98000, waitingLines: 0 })
    const { previewInvoiceReady } = ir
    const res = await get(`?patientId=${encodeURIComponent(pid)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(await previewInvoiceReady({ patientId: pid }))

    const r1 = await post({ patientId: pid })
    expect(r1.status).toBe(200)
    const body = await r1.json()
    expect(body.skipped).toEqual([])
    expect(body.created).toEqual([{ invoiceId: expect.any(Number), patientId: pid, lineCount: 3 }])
    const invoiceId = body.created[0].invoiceId
    const [inv] = await getDb().select().from(invoices).where(eq(invoices.id, invoiceId))
    expect([inv.status, inv.patientId, inv.encounterId, inv.admissionId, inv.payerId, inv.invoiceNumber]).toEqual(['draft', pid, e.id, null, null, null])
    expect((await linesOf(pid)).map((l) => [l.status, l.invoiceId])).toEqual([['captured', invoiceId], ['captured', invoiceId], ['captured', invoiceId]])
    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, pid), eq(auditLog.action, 'billing: invoiced ready lines')))
    expect(audit.map((a) => a.details)).toEqual(['invoices=1 lines=3 skipped=0'])

    // Repeat: nothing new.
    const r2 = await post({ patientId: pid })
    expect(await r2.json()).toEqual({ created: [], skipped: [] })
    expect(await getDb().select().from(invoices).where(eq(invoices.patientId, pid))).toHaveLength(1)
  })

  it('groups: an open visit waits, a no-context pharmacy line is its own draft, payer and self-pay lines of a stay are two drafts, an admitted stay waits', async () => {
    const { ir, getDb, admissions, chargeLines, payers, eq } = await m()
    const pid = await newPatient()
    const open = await encounter(pid)
    await pharmacyLine(pid, open.id)
    const loose = await pharmacyLine(pid, null, 4000)
    const [payer] = await getDb().insert(payers).values({ name: `Test WS2T12 Payer ${RUN}`, payerId: `${CODE}PY` }).returning()
    try {
      const [stay] = await getDb().insert(admissions).values({ patientId: pid, attendingProviderId: fx.prov, status: 'discharged', dischargedAt: NOW }).returning()
      const [ward] = await getDb().insert(admissions).values({ patientId: pid, attendingProviderId: fx.prov }).returning()
      const a = await pharmacyLine(pid, null, 6000)
      const b = await pharmacyLine(pid, null, 8000)
      const w = await pharmacyLine(pid, null, 10000)
      await getDb().update(chargeLines).set({ admissionId: stay.id, payerId: payer.id }).where(eq(chargeLines.id, a.id))
      await getDb().update(chargeLines).set({ admissionId: stay.id }).where(eq(chargeLines.id, b.id))
      await getDb().update(chargeLines).set({ admissionId: ward.id }).where(eq(chargeLines.id, w.id))
      expect(await ir.previewInvoiceReady({ patientId: pid })).toEqual({ groups: 3, lines: 3, taxablePaise: 18000, waitingLines: 2 })
      const r = await ir.invoiceReadyLines(billing, { patientId: pid })
      expect(r.skipped).toEqual([])
      expect(r.created.map((c) => c.lineCount)).toEqual([1, 1, 1])
      const lines = await linesOf(pid)
      const invOf = (id: number) => lines.find((l) => l.id === id)!.invoiceId
      expect(new Set([invOf(loose.id), invOf(a.id), invOf(b.id)]).size).toBe(3)
      expect(lines.filter((l) => l.invoiceId === null).map((l) => l.id).sort()).toEqual([lines[0].id, w.id].sort())
    } finally {
      await purge()
      await getDb().delete(payers).where(eq(payers.id, payer.id))
    }
  })

  it('billing dashboard tile: ready and waiting lines (and the ready value) from loadBillingQueue', async () => {
    const { kpi } = await m()
    const base = await kpi.loadBillingQueue()
    const p1 = await newPatient()
    const open = await encounter(p1)
    await pharmacyLine(p1, open.id, 1000)
    const p2 = await newPatient()
    await pharmacyLine(p2, null, 2400)
    const q = await kpi.loadBillingQueue()
    expect(q.readyLines - base.readyLines).toBe(1)
    expect(q.readyPaise - base.readyPaise).toBe(2400)
    expect(q.waitingLines - base.waitingLines).toBe(1)
    expect(q.uninvoicedLines - base.uninvoicedLines).toBe(2)
  })

  it('a group that loses a race (its line voided meanwhile) is skipped; the batch goes on', async () => {
    const { ir, chargeLines, eq } = await m()
    const pid = await newPatient()
    const l = await pharmacyLine(pid, null)
    const r = await whileBillingLocked(pid, () => ir.invoiceReadyLines(billing, { patientId: pid }), async (tx) => {
      await (tx as Db).update(chargeLines).set({ status: 'void', voidReason: 'Test', voidedAt: NOW, voidedByName: 'TEST' }).where(eq(chargeLines.id, l.id))
    })
    expect(r).toEqual({ created: [], skipped: [{ patientId: pid, error: 'lines_not_available' }] })
  })

  it('readiness is re-checked under the billing lock: a lab visit cancelled meanwhile is not drafted', async () => {
    const { ir, encounters, eq } = await m()
    const pid = await newPatient()
    const e = await encounter(pid, { encounterType: 'lab' })
    await pharmacyLine(pid, e.id)
    expect((await ir.previewInvoiceReady({ patientId: pid })).lines).toBe(1)
    const r = await whileBillingLocked(pid, () => ir.invoiceReadyLines(billing, { patientId: pid }), async (tx) => {
      await (tx as Db).update(encounters).set({ status: 'cancelled' }).where(eq(encounters.id, e.id))
    })
    expect(r).toEqual({ created: [], skipped: [{ patientId: pid, error: 'lines_not_available' }] })
    expect((await linesOf(pid)).map((l) => l.invoiceId)).toEqual([null])
  })

  it('two concurrent runs for one patient create one draft', async () => {
    const { ir, getDb, invoices, eq } = await m()
    const pid = await newPatient()
    await pharmacyLine(pid, null)
    const [a, b] = await Promise.all([ir.invoiceReadyLines(billing, { patientId: pid }), ir.invoiceReadyLines(billing, { patientId: pid })])
    expect(a.created.length + b.created.length).toBe(1)
    expect([...a.skipped, ...b.skipped].every((s) => s.error === 'lines_not_available')).toBe(true)
    expect(await getDb().select().from(invoices).where(eq(invoices.patientId, pid))).toHaveLength(1)
  })

  it('orders not billed: a lab order with a no_context outcome and a procedure with no live line; billed, cancelled and voided ones are not listed', async () => {
    const { ir, getDb, encounterProcedures, labOrders, eq } = await m()
    const pid = await newPatient()
    const loose = await labOrder(pid, null)
    expect(loose.charges).toEqual([{ ok: false, source: 'lab_order', reason: 'no_context' }])
    const e = await encounter(pid)
    const billed = await labOrder(pid, e.id)
    const cancelled = await labOrder(pid, null)
    await getDb().update(labOrders).set({ status: 'cancelled' }).where(eq(labOrders.id, cancelled.lines[0].orderId))
    const proc = async (voided: boolean) => (await getDb().insert(encounterProcedures).values({
      encounterId: e.id, patientId: pid, description: 'Dressing', performedOn: DAY, serviceId: fx.proc, createdByName: 'TEST-WS2T12', voidedAt: voided ? NOW : null,
    } as never).returning())[0]
    const p = await proc(false)
    const pv = await proc(true)
    const rows = (await ir.listUnbilledOrders()).filter((r) => r.patientId === pid)
    expect(rows).toEqual(expect.arrayContaining([
      { kind: 'lab_order', id: loose.lines[0].orderId, patientId: pid, patientName: `Test WS2T12 ${seq}`, uhid: `${CODE}${seq}`, itemName: `Test WS2T12 CBC ${RUN}`, createdAt: expect.any(Date) },
      { kind: 'procedure', id: p.id, patientId: pid, patientName: `Test WS2T12 ${seq}`, uhid: `${CODE}${seq}`, itemName: `Test WS2T12 P`, createdAt: expect.any(Date) },
    ]))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.id)).not.toContain(billed.lines[0].orderId)
    expect(rows.map((r) => r.id)).not.toContain(pv.id)
  })

  it('route: frontdesk (and other non-capture roles) 403; strict body and query 400; unknown patient 404', async () => {
    for (const r of ['frontdesk', 'pi', 'pharmacy', 'labs']) {
      role = r
      expect((await post({})).status).toBe(403)
      expect((await get('')).status).toBe(403)
    }
    role = 'billing'
    expect((await post({ patientId: 'RD-1', extra: 1 })).status).toBe(400)
    expect((await post({ patientId: 'bad id!' })).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
    expect((await get('?patientId=bad%20id')).status).toBe(400)
    expect((await get('?other=1')).status).toBe(400)
    expect((await post({ patientId: `TEST-WS2T12-${RUN}-none` })).status).toBe(404)
    expect((await get(`?patientId=TEST-WS2T12-${RUN}-none`)).status).toBe(404)
    const all = await get('')
    expect(all.status).toBe(200)
    expect(Object.keys(await all.json()).sort()).toEqual(['groups', 'lines', 'taxablePaise', 'waitingLines'])
  })
})
