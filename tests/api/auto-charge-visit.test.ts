import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Session } from '@/lib/auth'

// WS2 T9: automatic registration and consultation charges through the one auto-charge seam,
// against the real DB. Query-level checks pin `now` to 2099 (fixtures never meet real data;
// finalised documents number in the test-only 2099-00 year); the route checks use today.
let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'TEST-WS2T9 route', userId: null })) }))

const NOW = new Date('2099-07-01T06:00:00Z') // 11:30 IST
const LATER = new Date('2099-07-01T09:00:00Z')
const DAY = '2099-07-01'

describe.skipIf(!process.env.DATABASE_URL)('automatic visit charges (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const CODE = `TW9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const desk: Session = { role: 'frontdesk', name: `TEST-WS2T9-${RUN}`, userId: null }
  const doctor: Session = { role: 'admin', name: `TEST-WS2T9-${RUN}-dr`, userId: null }
  const billing: Session = { role: 'billing', name: `TEST-WS2T9-${RUN}-billing`, userId: null }
  const fx = {
    depA: 0, depB: 0, provA: 0, provB: 0, provNoDep: 0, consultA: 0, consultB: 0, regId: 0, preauthSvc: 0, payerId: 0,
    rateIds: [] as number[], admissionIds: [] as number[],
  }
  const PIDS: string[] = []
  let savedSettings: Record<string, unknown> | null = null
  let seq = 0

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    enc: await import('@/lib/queries/encounters'),
    ac: await import('@/lib/queries/auto-charge'),
    inv: await import('@/lib/queries/invoices'),
  })

  async function newPatient(over: Record<string, unknown> = {}): Promise<string> {
    const { getDb, patients } = await m()
    const id = `TEST-WS2T9-${RUN}-${++seq}`
    PIDS.push(id)
    await getDb().insert(patients).values({ id, name: `Test WS2T9 ${seq}`, dob: '1990-01-01', uhid: `${CODE}${seq}`, stateCode: 'IN-KA', addressLine1: '1 Test Street', phone: '9999999999', ...over } as never)
    return id
  }

  async function rate(serviceId: number, amountPaise: number) {
    const { getDb, tariffRates } = await m()
    const [r] = await getDb().insert(tariffRates).values({ serviceId, scope: 'base', amountPaise, validFrom: '2020-01-01', createdByName: 'TEST-WS2T9' }).returning()
    fx.rateIds.push(r.id)
    return r.id
  }

  const checkIn = async (patientId: string, over: Record<string, unknown> = {}, now = NOW) => {
    const { enc } = await m()
    const r = await enc.checkInVisit({
      patientId, providerId: fx.provA, visitType: 'outpatient', urgency: 'routine', reason: 'Test', appointmentId: null, ...over,
    } as never, desk, now)
    if (!r.ok) throw new Error(`check-in failed: ${r.error}`)
    return r
  }

  async function linesOf(patientId: string) {
    const { getDb, chargeLines, eq, asc } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.patientId, patientId)).orderBy(asc(chargeLines.id))
  }

  beforeAll(async () => {
    const { getDb, departments, providers, serviceCatalog, payers, billingSettings, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    const [depA] = await db.insert(departments).values({ code: `${CODE}A`, name: `Test WS2T9 A ${RUN}` }).returning()
    const [depB] = await db.insert(departments).values({ code: `${CODE}B`, name: `Test WS2T9 B ${RUN}` }).returning()
    fx.depA = depA.id; fx.depB = depB.id
    const prov = async (name: string, departmentId: number | null) =>
      (await db.insert(providers).values({ name, specialty: 'Test', colorTag: '#000000', departmentId }).returning())[0].id
    fx.provA = await prov(`TEST-WS2T9 Dr A ${RUN}`, depA.id)
    fx.provB = await prov(`TEST-WS2T9 Dr B ${RUN}`, depB.id)
    fx.provNoDep = await prov(`TEST-WS2T9 Dr N ${RUN}`, null)
    const svc = async (suffix: string, departmentId: number, category: 'consultation' | 'other', requiresPreauth = false) =>
      (await db.insert(serviceCatalog).values({ code: `${CODE}${suffix}`, name: `Test ${suffix}`, departmentId, category, hsnSac: '999312', gstRateBp: 0, requiresPreauth }).returning())[0].id
    fx.consultA = await svc('CA', depA.id, 'consultation')
    // A second, higher-id consultation service of department A never wins (lowest id is THE consultation).
    await svc('CA2', depA.id, 'consultation')
    fx.consultB = await svc('CB', depB.id, 'consultation')
    fx.regId = await svc('REG', depA.id, 'other')
    fx.preauthSvc = await svc('PA', depA.id, 'other', true)
    await rate(fx.consultA, 60000)
    await rate(fx.regId, 10000)
    await rate(fx.preauthSvc, 25000)
    const [payer] = await db.insert(payers).values({ name: `Test WS2T9 Payer ${RUN}`, payerId: CODE, requiresPreauth: true }).returning()
    fx.payerId = payer.id
    await db.update(billingSettings).set({ registrationServiceId: fx.regId, freeReviewDays: 0, legalName: 'Test WS2T9 Hospital', stateCode: 'IN-KA', gstin: null, placeOfSupplyMode: 'location_of_service' }).where(eq(billingSettings.id, 1))
  })

  afterEach(async () => {
    const { getDb, billingSettings, eq } = await m()
    const { purgeBillingFixtures } = await import('../db/billing-fixtures')
    await purgeBillingFixtures([...PIDS])
    await getDb().update(billingSettings).set({ registrationServiceId: fx.regId, freeReviewDays: 0 }).where(eq(billingSettings.id, 1))
  })

  afterAll(async () => {
    const { getDb, departments, providers, serviceCatalog, tariffRates, patients, encounters, admissions, doctorAssignments, payers, billingSettings, auditLog, eq, inArray, or } = await m()
    const { purgeBillingFixtures } = await import('../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures([...PIDS])
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    if (PIDS.length) {
      await db.delete(encounters).where(inArray(encounters.patientId, PIDS))
      await db.delete(admissions).where(inArray(admissions.patientId, PIDS))
      await db.delete(doctorAssignments).where(inArray(doctorAssignments.patientId, PIDS))
      await db.delete(auditLog).where(or(inArray(auditLog.patientId, PIDS), inArray(auditLog.userName, [desk.name, doctor.name, billing.name, 'TEST-WS2T9 route'])))
      await db.delete(patients).where(inArray(patients.id, PIDS))
    }
    await db.delete(payers).where(eq(payers.id, fx.payerId))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rateIds))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.departmentId, [fx.depA, fx.depB]))
    await db.delete(providers).where(inArray(providers.id, [fx.provA, fx.provB, fx.provNoDep]))
    await db.delete(departments).where(inArray(departments.id, [fx.depA, fx.depB]))
  })

  it('first OPD check-in captures one consultation and one registration line, self-pay at tariff, in the check-in', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid)
    expect(r.charges).toEqual([
      { ok: true, source: 'consultation', lineId: expect.any(Number), itemName: `Test CA`, taxablePaise: 60000, billTo: 'self', existing: false },
      { ok: true, source: 'registration', lineId: expect.any(Number), itemName: `Test REG`, taxablePaise: 10000, billTo: 'self', existing: false },
    ])
    const lines = await linesOf(pid)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => [l.source, l.serviceId, l.encounterId, l.payerId, l.unitPricePaise, l.priceSource, l.status, l.serviceDate])).toEqual([
      ['consultation', fx.consultA, r.encounter.id, null, 60000, 'base', 'captured', DAY],
      ['registration', fx.regId, r.encounter.id, null, 10000, 'base', 'captured', DAY],
    ])
    const { getDb, auditLog, eq } = await m()
    const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
    expect(audits).toContain(`billing: auto-captured consultation|line=${lines[0].id} service=${CODE}CA`)
    expect(audits).toContain(`billing: auto-captured registration|line=${lines[1].id} service=${CODE}REG`)
  })

  it('a failed check-in leaves no charge line (same transaction)', async () => {
    const pid = await newPatient()
    const { enc } = await m()
    await expect(enc.checkInVisit({ patientId: pid, providerId: 2147483000, visitType: 'outpatient', urgency: 'routine', reason: 'x', appointmentId: null }, desk, NOW)).rejects.toThrow()
    expect(await linesOf(pid)).toEqual([])
  })

  it('second check-in the same day: consultation only', async () => {
    const pid = await newPatient()
    await checkIn(pid)
    const second = await checkIn(pid)
    expect(second.charges).toEqual([expect.objectContaining({ ok: true, source: 'consultation', existing: false })])
    const lines = await linesOf(pid)
    expect(lines.filter((l) => l.source === 'registration')).toHaveLength(1)
    expect(lines.filter((l) => l.source === 'consultation').map((l) => l.encounterId).sort()).toHaveLength(2)
  })

  it('a department with no consultation rate: check-in succeeds with price_unresolved; completing after billing adds a rate captures it', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid, { providerId: fx.provB })
    expect(r.encounter.id).toBeGreaterThan(0)
    expect(r.charges[0]).toEqual({ ok: false, source: 'consultation', reason: 'price_unresolved', rules: ['price_unresolved'] })
    expect((await linesOf(pid)).filter((l) => l.source === 'consultation')).toEqual([])

    const rateId = await rate(fx.consultB, 45000)
    try {
      const { enc } = await m()
      const done = await enc.transitionEncounter(r.encounter.id, 'completed', doctor, { now: LATER })
      expect(done.ok).toBe(true)
      if (!done.ok) return
      expect(done.charges).toEqual([{ ok: true, source: 'consultation', lineId: expect.any(Number), itemName: 'Test CB', taxablePaise: 45000, billTo: 'self', existing: false }])
      expect((await linesOf(pid)).filter((l) => l.source === 'consultation' && l.encounterId === r.encounter.id)).toHaveLength(1)
    } finally {
      // Department B goes back to having no rate (afterAll deletes it once the lines are purged).
      const { getDb, tariffRates, eq } = await m()
      await getDb().update(tariffRates).set({ deactivatedAt: new Date() }).where(eq(tariffRates.id, rateId))
    }
  })

  it('completing a visit whose consultation exists returns it (existing: true) and keeps one line', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid)
    const { enc, ac, getDb } = await m()
    const done = await enc.transitionEncounter(r.encounter.id, 'completed', doctor, { now: LATER })
    expect(done.ok && done.charges).toEqual([expect.objectContaining({ ok: true, source: 'consultation', existing: true, taxablePaise: 60000 })])
    // The seam is idempotent when called again directly.
    const again = await getDb().transaction(async (tx) => ac.ensureConsultationChargeInTx(tx, done.ok ? done.encounter : r.encounter, doctor, LATER))
    expect(again).toMatchObject({ ok: true, existing: true })
    expect((await linesOf(pid)).filter((l) => l.source === 'consultation')).toHaveLength(1)
  })

  it('a doctor with no department: no consultation outcome, registration only', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid, { providerId: fx.provNoDep })
    expect(r.charges.map((c) => c.source)).toEqual(['registration'])
  })

  // WS3 T2: inpatients are admitted by admitPatient, not check-in; the visit-charge plan still
  // owes nothing for an IPD encounter.
  it('an IPD encounter captures no visit charges', async () => {
    const pid = await newPatient()
    const { getDb, encounters, ac } = await m()
    const [e] = await getDb().insert(encounters).values({ patientId: pid, encounterType: 'ipd', encounterDate: DAY, providerId: fx.provA, checkedInByName: desk.name, checkedInAt: NOW }).returning()
    expect(await getDb().transaction(async (tx) => ac.captureVisitChargesInTx(tx, e, desk, NOW))).toEqual([])
    expect(await linesOf(pid)).toEqual([])
  })

  it('cancelling voids both lines; the next visit is charged registration again', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid)
    const { enc, getDb, auditLog, eq } = await m()
    const c = await enc.transitionEncounter(r.encounter.id, 'cancelled', desk, { cancelReason: 'Left', now: LATER })
    expect(c.ok).toBe(true)
    const lines = await linesOf(pid)
    expect(lines.map((l) => [l.status, l.voidReason, l.voidedByName, l.invoiceId])).toEqual([
      ['void', 'Visit cancelled', desk.name, null], ['void', 'Visit cancelled', desk.name, null],
    ])
    const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
    expect(audits).toContain(`billing: voided charge line|line=${lines[0].id} encounter=${r.encounter.id} cause=visit_cancelled`)
    const next = await checkIn(pid)
    expect(next.charges.map((x) => x.ok && x.source)).toEqual(['consultation', 'registration'])
  })

  it('lines on a draft invoice are voided and leave the draft', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid)
    const { enc, inv } = await m()
    const ids = (await linesOf(pid)).map((l) => l.id)
    const d = await inv.createDraftInvoice(ids, billing)
    expect(d.ok).toBe(true)
    expect((await linesOf(pid)).every((l) => l.invoiceId !== null)).toBe(true)
    const c = await enc.transitionEncounter(r.encounter.id, 'cancelled', desk, { cancelReason: 'Left', now: LATER })
    expect(c.ok).toBe(true)
    expect((await linesOf(pid)).map((l) => [l.status, l.invoiceId])).toEqual([['void', null], ['void', null]])
  })

  it('cancelling after the lines are on a finalised invoice is refused (visit_billed) and changes nothing', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid)
    const { enc, inv, getDb, encounters, eq } = await m()
    const ids = (await linesOf(pid)).map((l) => l.id)
    const d = await inv.createDraftInvoice(ids, billing)
    if (!d.ok) throw new Error(d.error)
    const f = await inv.finaliseInvoice(d.invoiceId, billing, NOW)
    if (!f.ok) throw new Error(f.error)
    const c = await enc.transitionEncounter(r.encounter.id, 'cancelled', desk, { cancelReason: 'Left', now: LATER })
    expect(c).toEqual({ ok: false, error: 'visit_billed', invoiceNumber: f.invoiceNumber })
    const [after] = await getDb().select().from(encounters).where(eq(encounters.id, r.encounter.id))
    expect(after.status).toBe('checked_in')
    expect(after.cancelReason).toBeNull()
    expect((await linesOf(pid)).map((l) => [l.status, l.invoiceId])).toEqual([['invoiced', d.invoiceId], ['invoiced', d.invoiceId]])
  })

  it('a follow-up within free_review_days of the last charged consultation gets no consultation', async () => {
    const pid = await newPatient()
    await checkIn(pid)
    const { getDb, billingSettings, encounters, eq, ac } = await m()
    await getDb().update(billingSettings).set({ freeReviewDays: 7 }).where(eq(billingSettings.id, 1))
    const [fu] = await getDb().insert(encounters).values({
      patientId: pid, encounterType: 'opd', visitType: 'follow_up', encounterDate: '2099-07-05', providerId: fx.provA, departmentId: fx.depA, checkedInByName: desk.name,
    }).returning()
    const out = await getDb().transaction(async (tx) => ac.captureVisitChargesInTx(tx, fu, desk, new Date('2099-07-05T06:00:00Z')))
    expect(out).toEqual([])
    expect(await getDb().transaction(async (tx) => ac.ensureConsultationChargeInTx(tx, fu, desk, new Date('2099-07-05T06:00:00Z')))).toBeNull()
    // Day 9 is charged.
    const [late] = await getDb().insert(encounters).values({
      patientId: pid, encounterType: 'opd', visitType: 'follow_up', encounterDate: '2099-07-09', providerId: fx.provA, departmentId: fx.depA, checkedInByName: desk.name,
    }).returning()
    const out2 = await getDb().transaction(async (tx) => ac.captureVisitChargesInTx(tx, late, desk, new Date('2099-07-09T06:00:00Z')))
    expect(out2).toEqual([expect.objectContaining({ ok: true, source: 'consultation' })])
  })

  it('two concurrent first check-ins of one patient capture one registration line', async () => {
    const pid = await newPatient()
    const rs = await Promise.all([checkIn(pid), checkIn(pid)])
    const regs = (await linesOf(pid)).filter((l) => l.source === 'registration')
    expect(regs).toHaveLength(1)
    expect(rs.flatMap((r) => r.charges).filter((c) => c.source === 'registration')).toHaveLength(1)
  })

  it('an admission line bills the payer, falling back to self-pay (audited) when only pre-auth blocks', async () => {
    const pid = await newPatient({ primaryPayerId: fx.payerId })
    const { getDb, admissions, auditLog, eq, ac } = await m()
    const [adm] = await getDb().insert(admissions).values({ patientId: pid, attendingProviderId: fx.provA, admittedAt: new Date('2099-06-30T06:00:00Z') }).returning()
    fx.admissionIds.push(adm.id)
    const out = await getDb().transaction(async (tx) => ac.captureAutoChargeInTx(tx, {
      context: { admissionId: adm.id }, serviceId: fx.preauthSvc, quantity: 1, serviceDate: DAY, source: 'procedure',
    }, doctor, NOW))
    expect(out).toMatchObject({ ok: true, source: 'procedure', billTo: 'self', taxablePaise: 25000, existing: false })
    const lines = await linesOf(pid)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ payerId: null, source: 'procedure', admissionId: adm.id })
    const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
    expect(audits).toContain(`billing: auto charge fell back to self-pay|line=${lines[0].id} rules=preauth_required`)
    // A service without a payer-only block bills the payer.
    const payerLine = await getDb().transaction(async (tx) => ac.captureAutoChargeInTx(tx, {
      context: { admissionId: adm.id }, serviceId: fx.regId, quantity: 1, serviceDate: DAY, source: 'registration',
    }, doctor, NOW))
    expect(payerLine).toMatchObject({ ok: true, billTo: 'payer' })
  })

  it('a missing context or unknown service never throws', async () => {
    const { getDb, ac } = await m()
    const pid = await newPatient()
    const r = await checkIn(pid)
    const none = await getDb().transaction(async (tx) => ac.captureAutoChargeInTx(tx, { context: { encounterId: 2147483000 }, serviceId: fx.consultA, quantity: 1, serviceDate: DAY, source: 'consultation' }, desk, NOW))
    expect(none).toEqual({ ok: false, source: 'consultation', reason: 'no_context' })
    const unknown = await getDb().transaction(async (tx) => ac.captureAutoChargeInTx(tx, { context: { encounterId: r.encounter.id }, serviceId: 2147483000, quantity: 1, serviceDate: DAY, source: 'procedure' }, desk, NOW))
    expect(unknown).toEqual({ ok: false, source: 'procedure', reason: 'blocked', rules: ['service_not_found'] })
  })

  // WS2 T10 (T9 review a): a unique violation on the insert must not abort the caller's transaction.
  it('a line inserted concurrently without the billing lock comes back existing:true and the caller still commits', async () => {
    const pid = await newPatient()
    const r = await checkIn(pid)
    const { getDb, chargeLines, auditLog, eq, and, sql, ac } = await m()
    const db = getDb()
    const [consult] = (await linesOf(pid)).filter((l) => l.source === 'consultation')
    // Void it so the capture's own lookup finds nothing live, then race a raw live copy in.
    await db.update(chargeLines).set({ status: 'void', voidReason: 'test', voidedAt: NOW, voidedByName: 'test' }).where(eq(chargeLines.id, consult.id))
    const { id: _id, ...copy } = consult
    void _id
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    let inserted!: (id: number) => void
    const racedId = new Promise<number>((res) => { inserted = res })
    const other = db.transaction(async (tx) => {
      const [row] = await tx.insert(chargeLines).values({ ...copy, status: 'captured', voidReason: null, voidedAt: null, voidedByName: null }).returning({ id: chargeLines.id })
      inserted(row.id)
      await gate
    })
    const raced = await racedId
    const mine = db.transaction(async (tx) => {
      const out = await ac.captureAutoChargeInTx(tx, { context: { encounterId: r.encounter.id }, serviceId: fx.consultA, quantity: 1, serviceDate: DAY, source: 'consultation' }, doctor, NOW)
      await tx.insert(auditLog).values({ userName: doctor.name, role: 'admin', action: 'test: after capture', patientId: pid, details: 'race' } as never)
      return out
    })
    // Wait until the capture's insert is blocked on the uncommitted unique row, then commit it.
    for (let i = 0; i < 200; i++) {
      const res = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'insert into "charge_lines"%'`)
      if (Number((res as unknown as { rows: { n: number }[] }).rows[0].n) > 0) break
      await new Promise((res) => setTimeout(res, 25))
    }
    release()
    await other
    const out = await mine
    expect(out).toMatchObject({ ok: true, source: 'consultation', lineId: raced, existing: true })
    expect((await linesOf(pid)).filter((l) => l.source === 'consultation' && l.status !== 'void').map((l) => l.id)).toEqual([raced])
    const after = await db.select().from(auditLog).where(and(eq(auditLog.patientId, pid), eq(auditLog.action, 'test: after capture')))
    expect(after).toHaveLength(1)
  })

  // WS2 T10 (T9 review b): the registration fee is billed once per patient, not once per surviving visit.
  it('cancelling the visit holding the registration line moves it to the patient\'s earliest other live visit', async () => {
    const pid = await newPatient()
    const first = await checkIn(pid)
    const second = await checkIn(pid, {}, LATER)
    const { enc, getDb, auditLog, eq } = await m()
    const reg = (await linesOf(pid)).find((l) => l.source === 'registration')!
    expect(reg.encounterId).toBe(first.encounter.id)
    const c = await enc.transitionEncounter(first.encounter.id, 'cancelled', desk, { cancelReason: 'Duplicate', now: LATER })
    expect(c.ok).toBe(true)
    const lines = await linesOf(pid)
    const regAfter = lines.find((l) => l.id === reg.id)!
    expect([regAfter.status, regAfter.encounterId, regAfter.serviceDate, regAfter.invoiceId]).toEqual(['captured', second.encounter.id, DAY, null])
    expect(lines.filter((l) => l.source === 'consultation').map((l) => [l.encounterId, l.status])).toEqual([
      [first.encounter.id, 'void'], [second.encounter.id, 'captured'],
    ])
    const audits = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))).map((a) => `${a.action}|${a.details}`)
    expect(audits).toContain(`billing: moved registration line|line=${reg.id} from=${first.encounter.id} to=${second.encounter.id}`)
    // Cancelling the last live visit voids it; the next visit pays registration again.
    expect((await enc.transitionEncounter(second.encounter.id, 'cancelled', desk, { cancelReason: 'Left', now: LATER })).ok).toBe(true)
    expect((await linesOf(pid)).find((l) => l.id === reg.id)!.status).toBe('void')
    const third = await checkIn(pid, {}, LATER)
    expect(third.charges.map((x) => x.ok && x.source)).toEqual(['consultation', 'registration'])
  })

  describe('routes', () => {
    it('POST /api/front-desk/check-in: 201 with charges; an unpriced department still checks in', async () => {
      role = 'frontdesk'
      const pid = await newPatient()
      const { POST } = await import('@/app/api/front-desk/check-in/route')
      const res = await POST(new Request('http://localhost/api/front-desk/check-in', { method: 'POST', body: JSON.stringify({ patientId: pid, providerId: fx.provB, visitType: 'outpatient', urgency: 'routine', reason: 'Fever' }) }) as never)
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.encounterId).toEqual(expect.any(Number))
      expect(body.charges[0]).toEqual({ ok: false, source: 'consultation', reason: 'price_unresolved', rules: ['price_unresolved'] })
      expect(body.charges[1]).toMatchObject({ ok: true, source: 'registration', taxablePaise: 10000 })
    })

    const preview = async (q: string) => {
      const { GET } = await import('@/app/api/front-desk/check-in/fee-preview/route')
      return GET(new NextRequest(`http://localhost/api/front-desk/check-in/fee-preview?${q}`))
    }

    it('GET fee-preview: CHECK_IN_ROLES only', async () => {
      const pid = await newPatient()
      for (const r of ['pi', 'billing', 'pharmacy', 'labs']) {
        role = r
        const res = await preview(`patientId=${pid}&providerId=${fx.provA}&visitType=outpatient&urgency=routine`)
        expect(res.status, r).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden' })
      }
      for (const r of ['frontdesk', 'admin', 'crc']) {
        role = r
        expect((await preview(`patientId=${pid}&providerId=${fx.provA}&visitType=outpatient&urgency=routine`)).status, r).toBe(200)
      }
    })

    it('GET fee-preview: the fees a check-in would charge, notes, strict query and 404s', async () => {
      role = 'frontdesk'
      const pid = await newPatient()
      const first = await preview(`patientId=${pid}&providerId=${fx.provA}&visitType=outpatient&urgency=routine`)
      expect(await first.json()).toEqual({ registration: { itemName: 'Test REG', amountPaise: 10000 }, consultation: { itemName: 'Test CA', amountPaise: 60000 }, note: null })
      const noRate = await preview(`patientId=${pid}&providerId=${fx.provB}&visitType=outpatient&urgency=routine`)
      expect(await noRate.json()).toEqual({ registration: { itemName: 'Test REG', amountPaise: 10000 }, consultation: null, note: 'no_rate' })
      const noDep = await preview(`patientId=${pid}&providerId=${fx.provNoDep}&visitType=outpatient&urgency=routine`)
      expect((await noDep.json()).note).toBe('no_department')
      const ipd = await preview(`patientId=${pid}&providerId=${fx.provA}&visitType=inpatient&urgency=urgent`)
      expect(await ipd.json()).toEqual({ registration: null, consultation: null, note: 'inpatient' })
      expect((await preview(`patientId=${pid}&providerId=${fx.provA}&visitType=outpatient&urgency=routine&x=1`)).status).toBe(400)
      expect((await preview(`patientId=${pid}&providerId=abc&visitType=outpatient&urgency=routine`)).status).toBe(400)
      expect((await preview(`patientId=RD-ZZZZ-NOPE&providerId=${fx.provA}&visitType=outpatient&urgency=routine`)).status).toBe(404)
      expect((await preview(`patientId=${pid}&providerId=2147483000&visitType=outpatient&urgency=routine`)).status).toBe(404)
    })
  })
})
