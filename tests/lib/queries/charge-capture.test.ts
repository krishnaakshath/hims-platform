import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'
import type { ChargeCaptureInput } from '@/lib/billing/validation'

// SP4 Task 7: charge capture against the real DB. Fixtures live in 2099 so they never meet real data;
// `now` is pinned to 2099-06-01 11:30 IST.
const NOW = new Date('2099-06-01T06:00:00Z')
const DAY = '2099-06-01'

describe.skipIf(!process.env.DATABASE_URL)('charge capture (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const PID_LAB = `TEST-SP4-${RUN}-LAB`
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const crc: Session = { role: 'crc', name: `TEST-SP4-${RUN}-crc`, userId: null }
  const billing: Session = { role: 'billing', name: `TEST-SP4-${RUN}-billing`, userId: null }
  const fx = {
    departmentId: 0, providerId: 0, roomCategoryId: 0, roomId: 0, consultId: 0, procId: 0, noRateId: 0,
    opdEncounterId: 0, labEncounterId: 0, cancelledEncounterId: 0, admissionId: 0, rateIds: [] as number[], procBaseRateId: 0,
  }
  let savedSettings: Record<string, unknown> | null = null

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    cc: await import('@/lib/queries/charge-capture'),
  })

  beforeAll(async () => {
    const { getDb, departments, providers, roomCategories, rooms, serviceCatalog, tariffRates, patients, encounters, admissions, billingSettings, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    await db.update(billingSettings).set({ legalName: 'Test SP4 Hospital', stateCode: 'IN-KA', gstin: null, ipdDepositThresholdPaise: 0, consultationWindowDays: 30, placeOfSupplyMode: 'location_of_service' }).where(eq(billingSettings.id, 1))

    const [prov] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    fx.providerId = prov.id
    const [dep] = await db.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [cat] = await db.insert(roomCategories).values({ code: `${CODE}ICU`, name: 'Test ICU' }).returning()
    fx.roomCategoryId = cat.id
    const [room] = await db.insert(rooms).values({ ward: 'Test SP4 Ward', roomNumber: CODE, bedNumber: '1', roomCategoryId: cat.id }).returning()
    fx.roomId = room.id
    const svc = async (suffix: string, category: 'consultation' | 'procedure', gstRateBp = 0) =>
      (await db.insert(serviceCatalog).values({ code: `${CODE}${suffix}`, name: `Test ${suffix}`, departmentId: dep.id, category, hsnSac: '999312', gstRateBp }).returning())[0].id
    fx.consultId = await svc('C', 'consultation')
    fx.procId = await svc('P', 'procedure', 1800)
    fx.noRateId = await svc('N', 'consultation')
    const rate = async (serviceId: number, amountPaise: number, roomCategoryId: number | null = null) =>
      (await db.insert(tariffRates).values({ serviceId, scope: 'base', amountPaise, validFrom: '2099-01-01', roomCategoryId, createdByName: 'TEST-SP4' }).returning())[0].id
    fx.rateIds.push(await rate(fx.consultId, 50000))
    fx.procBaseRateId = await rate(fx.procId, 50000)
    fx.rateIds.push(fx.procBaseRateId, await rate(fx.procId, 90000, cat.id))

    await db.insert(patients).values([{ id: PID, name: 'Test SP4 Capture', dob: '1990-01-01' }, { id: PID_LAB, name: 'Test SP4 Lab', dob: '1990-01-01' }])
    const enc = async (patientId: string, encounterType: 'opd' | 'lab' | 'ipd', status: 'checked_in' | 'cancelled' = 'checked_in', admissionId: number | null = null) =>
      (await db.insert(encounters).values({ patientId, encounterType, status, encounterDate: DAY, providerId: prov.id, departmentId: dep.id, admissionId, checkedInByName: 'TEST-SP4' }).returning())[0].id
    fx.opdEncounterId = await enc(PID, 'opd')
    fx.labEncounterId = await enc(PID_LAB, 'lab')
    fx.cancelledEncounterId = await enc(PID, 'opd', 'cancelled')
    const [adm] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: prov.id, currentRoomId: room.id, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.admissionId = adm.id
  })

  afterEach(async () => {
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    await purgeBillingFixtures([PID, PID_LAB])
  })

  afterAll(async () => {
    const { getDb, departments, roomCategories, rooms, serviceCatalog, tariffRates, patients, encounters, admissions, billingSettings, auditLog, eq, inArray } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures([PID, PID_LAB])
    await db.delete(admissions).where(eq(admissions.id, fx.admissionId))
    await db.delete(encounters).where(inArray(encounters.patientId, [PID, PID_LAB]))
    await db.delete(patients).where(inArray(patients.id, [PID, PID_LAB]))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rateIds))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [fx.consultId, fx.procId, fx.noRateId]))
    await db.delete(rooms).where(eq(rooms.id, fx.roomId))
    await db.delete(roomCategories).where(eq(roomCategories.id, fx.roomCategoryId))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
    await db.delete(auditLog).where(inArray(auditLog.patientId, [PID, PID_LAB]))
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
  })

  const opd = (over: Partial<ChargeCaptureInput> = {}): ChargeCaptureInput => ({
    context: { encounterId: fx.opdEncounterId }, serviceId: fx.consultId, quantity: 1, serviceDate: DAY, billTo: 'patient', ...over,
  })

  async function audit(patientId = PID) {
    const { getDb, auditLog, eq, asc } = await m()
    return getDb().select().from(auditLog).where(eq(auditLog.patientId, patientId)).orderBy(asc(auditLog.id))
  }

  it('loads an encounter and an admission context', async () => {
    const { getDb, cc } = await m()
    const e = await cc.loadChargeContext(getDb(), { encounterId: fx.opdEncounterId })
    expect(e).toMatchObject({ kind: 'encounter', patientId: PID, encounterId: fx.opdEncounterId, admissionId: null, departmentId: fx.departmentId,
      orderingProviderId: fx.providerId, startDate: DAY, endDate: null, isInpatient: false, isEmergencyAdmission: false, cancelled: false })
    const a = await cc.loadChargeContext(getDb(), { admissionId: fx.admissionId })
    expect(a).toMatchObject({ kind: 'admission', patientId: PID, admissionId: fx.admissionId, startDate: '2099-05-30', endDate: null, isInpatient: true,
      roomCategoryCode: `${CODE}ICU`, ward: 'Test SP4 Ward', orderingProviderId: fx.providerId, cancelled: false })
    expect(await cc.loadChargeContext(getDb(), { encounterId: 2_147_483_000 })).toBeNull()
    expect((await cc.loadChargeContext(getDb(), { encounterId: fx.cancelledEncounterId }))!.cancelled).toBe(true)
  })

  it('prices from the resolver and snapshots the rate id and scope', async () => {
    const { cc } = await m()
    const r = await cc.captureChargeLine(opd({ serviceId: fx.procId, quantity: 3 }), crc, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.line).toMatchObject({
      unitPricePaise: 50000, priceSource: 'base', tariffRateId: fx.procBaseRateId, taxablePaise: 150000, quantity: 3, gstRateBp: 1800,
      itemCode: `${CODE}P`, itemName: 'Test P', serviceCategory: 'procedure', status: 'captured', source: 'manual', encounterId: fx.opdEncounterId,
      orderingProviderId: fx.providerId, payerId: null, resolvedPricePaise: null, createdByName: crc.name,
    })
  })

  it('preview estimates intra-state GST and never writes', async () => {
    const { cc, getDb, chargeLines, eq } = await m()
    const r = await cc.previewChargeLine(opd({ serviceId: fx.procId, quantity: 2 }), crc, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.preview).toMatchObject({ unitPricePaise: 50000, priceSource: 'base', taxablePaise: 100000, unresolved: [] })
    expect(r.preview.estimatedTax).toMatchObject({ cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000 })
    expect(await getDb().select().from(chargeLines).where(eq(chargeLines.patientId, PID))).toEqual([])
  })

  it('uses the room category rate for an admission', async () => {
    const { cc } = await m()
    const r = await cc.captureChargeLine({ ...opd({ serviceId: fx.procId }), context: { admissionId: fx.admissionId } }, crc, NOW)
    expect(r.ok && r.line.unitPricePaise).toBe(90000)
    expect(r.ok && r.line.admissionId).toBe(fx.admissionId)
  })

  it('blocks no_rate unless an authority role gives a manual price', async () => {
    const { cc } = await m()
    const blocked = await cc.captureChargeLine(opd({ serviceId: fx.noRateId }), crc, NOW)
    expect(blocked).toMatchObject({ ok: false, error: 'blocked' })
    expect(!blocked.ok && blocked.violations!.map((v) => v.code)).toContain('price_unresolved')
    const manual = { manualUnitPricePaise: 70000, priceOverrideReason: 'Agreed package rate' }
    expect(await cc.captureChargeLine(opd({ serviceId: fx.noRateId, ...manual }), crc, NOW)).toEqual({ ok: false, error: 'price_override_forbidden' })
    expect(await cc.previewChargeLine(opd({ serviceId: fx.noRateId, ...manual }), crc, NOW)).toEqual({ ok: false, error: 'price_override_forbidden' })
    const ok = await cc.captureChargeLine(opd({ serviceId: fx.noRateId, ...manual }), billing, NOW)
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.line).toMatchObject({ priceSource: 'manual', unitPricePaise: 70000, resolvedPricePaise: null, priceOverrideReason: 'Agreed package rate' })
    const rows = await audit()
    expect(rows.map((a) => `${a.action}|${a.details}`)).toContain(`billing: overrode charge price|line=${ok.line.id} resolved=none charged=70000`)
    expect(rows.map((a) => `${a.action}|${a.details}`)).toContain(`billing: captured charge line|line=${ok.line.id} service=${CODE}N qty=1 price=manual`)
  })

  it('a manual price over a resolved one records the resolved amount', async () => {
    const { cc } = await m()
    const ok = await cc.captureChargeLine(opd({ manualUnitPricePaise: 40000, priceOverrideReason: 'Staff discount agreed' }), billing, NOW)
    expect(ok.ok && ok.line).toMatchObject({ priceSource: 'manual', unitPricePaise: 40000, resolvedPricePaise: 50000 })
  })

  it('two concurrent identical captures: one line, one duplicate_charge refusal', async () => {
    const { cc, getDb, chargeLines, eq } = await m()
    const req = opd()
    const [a, b] = await Promise.all([cc.captureChargeLine(req, crc, NOW), cc.captureChargeLine(req, crc, NOW)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    const refused = a.ok ? b : a
    expect(!refused.ok && refused.error).toBe('blocked')
    expect(!refused.ok && refused.violations!.map((v) => v.code)).toContain('duplicate_charge')
    expect(await getDb().select().from(chargeLines).where(eq(chargeLines.patientId, PID))).toHaveLength(1)
  })

  it('billing may override the duplicate with a reason; the override is stored and audited', async () => {
    const { cc } = await m()
    expect((await cc.captureChargeLine(opd(), billing, NOW)).ok).toBe(true)
    const crcTry = await cc.captureChargeLine(opd({ overrides: [{ code: 'duplicate_charge', reason: 'Second consult same day' }] }), crc, NOW)
    expect(crcTry).toMatchObject({ ok: false, error: 'blocked' })
    const r = await cc.captureChargeLine(opd({ overrides: [{ code: 'duplicate_charge', reason: 'Second consult same day' }] }), billing, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.line.ruleOverrides).toEqual([{ code: 'duplicate_charge', reason: 'Second consult same day' }])
    expect(r.line.violations.map((v) => v.code)).toEqual(['duplicate_charge'])
    expect((await audit()).map((a) => `${a.action}|${a.details}`)).toContain(`billing: overrode charge rule|line=${r.line.id} rules=duplicate_charge`)
  })

  it('a procedure without a recent consultation is blocked for an encounter-less lab context', async () => {
    const { cc } = await m()
    const r = await cc.captureChargeLine({ context: { encounterId: fx.labEncounterId }, serviceId: fx.procId, quantity: 1, serviceDate: DAY, billTo: 'patient' }, crc, NOW)
    expect(r).toMatchObject({ ok: false, error: 'blocked' })
    expect(!r.ok && r.violations!.map((v) => v.code)).toContain('consultation_required')
  })

  it('deposit threshold blocks an IPD procedure until an advance is recorded', async () => {
    const { cc, getDb, billingSettings, patientPayments, eq } = await m()
    const db = getDb()
    await db.update(billingSettings).set({ ipdDepositThresholdPaise: 500000 }).where(eq(billingSettings.id, 1))
    try {
      const req: ChargeCaptureInput = { context: { admissionId: fx.admissionId }, serviceId: fx.procId, quantity: 1, serviceDate: DAY, billTo: 'patient' }
      const blocked = await cc.captureChargeLine(req, crc, NOW)
      expect(blocked).toMatchObject({ ok: false, error: 'blocked' })
      expect(!blocked.ok && blocked.violations!.map((v) => v.code)).toContain('deposit_below_threshold')
      await db.insert(patientPayments).values({
        receiptNumber: `RCT/99-00/${RUN}`, kind: 'advance', patientId: PID, admissionId: fx.admissionId, mode: 'cash', amountPaise: 500000,
        financialYear: '2099-00', receiptDate: DAY, receivedByName: 'TEST-SP4',
      })
      expect((await cc.captureChargeLine(req, crc, NOW)).ok).toBe(true)
    } finally {
      await db.update(billingSettings).set({ ipdDepositThresholdPaise: 0 }).where(eq(billingSettings.id, 1))
    }
  })

  it('a cancelled encounter refuses capture; a missing context is not found; payer billing needs a payer', async () => {
    const { cc } = await m()
    expect(await cc.captureChargeLine(opd({ context: { encounterId: fx.cancelledEncounterId } }), crc, NOW)).toEqual({ ok: false, error: 'context_cancelled' })
    expect(await cc.captureChargeLine(opd({ context: { encounterId: 2_147_483_000 } }), crc, NOW)).toEqual({ ok: false, error: 'context_not_found' })
    expect(await cc.captureChargeLine(opd({ billTo: 'payer' }), crc, NOW)).toEqual({ ok: false, error: 'no_payer' })
  })

  it('a service date outside the visit is blocked', async () => {
    const { cc } = await m()
    const r = await cc.captureChargeLine(opd({ serviceDate: '2099-05-31' }), crc, NOW)
    expect(!r.ok && r.violations!.map((v) => v.code)).toContain('date_outside_encounter')
  })

  it('a mapped service refuses an unmapped procedure code and auto-fills the primary (SP6 service map)', async () => {
    const { getDb, sql, cc } = await m()
    const db = getDb()
    await db.execute(sql`insert into service_procedure_codes (service_id, code_system_kind, code, is_primary, created_by_name)
      values (${fx.procId}, 'icd10pcs', 'TSP4A', true, 'TEST-SP4'), (${fx.procId}, 'icd10pcs', 'TSP4B', false, 'TEST-SP4')`)
    try {
      const bad = await cc.captureChargeLine(opd({ serviceId: fx.procId, procedureCodes: [{ kind: 'icd10pcs', code: 'ZZZ' }] }), crc, NOW)
      expect(!bad.ok && bad.violations!.map((v) => v.code)).toContain('procedure_code_not_mapped')
      const ok = await cc.captureChargeLine(opd({ serviceId: fx.procId }), crc, NOW)
      expect(ok.ok && ok.line.procedureCodes).toEqual([{ kind: 'icd10pcs', code: 'TSP4A' }])
    } finally {
      await db.execute(sql`delete from service_procedure_codes where service_id = ${fx.procId}`)
    }
  })

  it('void keeps the row with its reason and frees it from a draft invoice', async () => {
    const { cc, getDb, chargeLines, invoices, eq } = await m()
    const db = getDb()
    const r = await cc.captureChargeLine(opd(), crc, NOW)
    if (!r.ok) throw new Error('capture failed')
    const [inv] = await db.insert(invoices).values({ patientId: PID, encounterId: fx.opdEncounterId, createdByName: 'TEST-SP4' }).returning()
    await db.update(chargeLines).set({ invoiceId: inv.id }).where(eq(chargeLines.id, r.line.id))
    expect(await cc.voidChargeLine(r.line.id, 'Entered against the wrong visit', crc)).toEqual({ ok: true })
    const [row] = await db.select().from(chargeLines).where(eq(chargeLines.id, r.line.id))
    expect(row).toMatchObject({ status: 'void', voidReason: 'Entered against the wrong visit', voidedByName: crc.name, invoiceId: null })
    expect(row.voidedAt).toBeInstanceOf(Date)
    expect(await cc.voidChargeLine(r.line.id, 'Again please', crc)).toEqual({ ok: false, error: 'not_voidable' })
    expect(await cc.voidChargeLine(2_147_483_000, 'Missing line', crc)).toEqual({ ok: false, error: 'not_found' })
    expect((await audit()).map((a) => `${a.action}|${a.details}`)).toContain(`billing: voided charge line|line=${r.line.id}`)
  })

  it('an invoiced line cannot be voided', async () => {
    const { cc, getDb, chargeLines, eq } = await m()
    const r = await cc.captureChargeLine(opd(), crc, NOW)
    if (!r.ok) throw new Error('capture failed')
    await getDb().update(chargeLines).set({ status: 'invoiced' }).where(eq(chargeLines.id, r.line.id))
    expect(await cc.voidChargeLine(r.line.id, 'Should not work', crc)).toEqual({ ok: false, error: 'not_voidable' })
  })

  it('audit details carry ids and codes only', async () => {
    const { cc } = await m()
    const r = await cc.captureChargeLine(opd({ serviceId: fx.noRateId, manualUnitPricePaise: 1000, priceOverrideReason: 'SECRET-REASON-TEXT' }), billing, NOW)
    if (!r.ok) throw new Error('capture failed')
    await cc.voidChargeLine(r.line.id, 'SECRET-VOID-REASON', billing)
    const text = JSON.stringify((await audit()).map((a) => [a.action, a.details]))
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('Test N')
  })

  it('capture screen reads: header with deposit, the context lines, today\'s visits and admissions', async () => {
    const { cc } = await m()
    const r = await cc.captureChargeLine({ ...opd({ serviceId: fx.procId }), context: { admissionId: fx.admissionId } }, crc, NOW)
    expect(r.ok).toBe(true)
    const h = await cc.getCaptureHeader({ admissionId: fx.admissionId })
    expect(h).toMatchObject({ kind: 'admission', patientId: PID, patientName: 'Test SP4 Capture', payerName: null, depositPaise: 0, primaryPayerId: null })
    expect(h!.label).toContain('30 May 2099')
    expect((await cc.getCaptureHeader({ encounterId: fx.opdEncounterId }))).toMatchObject({ kind: 'encounter', depositPaise: null, label: 'Outpatient visit, 1 Jun 2099' })
    expect(await cc.getCaptureHeader({ admissionId: 2_147_483_000 })).toBeNull()
    expect((await cc.listChargeLinesForContext({ admissionId: fx.admissionId })).map((l) => l.serviceId)).toEqual([fx.procId])
    const lists = await cc.listCaptureContexts(DAY)
    expect(lists.encounters.map((e) => e.id)).toContain(fx.opdEncounterId)
    expect(lists.encounters.map((e) => e.id)).not.toContain(fx.cancelledEncounterId)
    expect(lists.admissions.find((a) => a.id === fx.admissionId)).toMatchObject({ patientName: 'Test SP4 Capture', ward: 'Test SP4 Ward', admittedOn: '2099-05-30' })
  })

  it('loadMappedProcedureCodes returns [] when the SP6 table is absent', async () => {
    const { loadMappedProcedureCodes } = await import('@/lib/queries/service-code-lookup')
    let calls = 0
    const executor = { execute: async () => { calls++; return { rows: [{ present: false }] } } }
    expect(await loadMappedProcedureCodes(executor as never, 1)).toEqual([])
    expect(calls).toBe(1)
  })

  it('pharmacy lines with no visit or stay: listed per patient while unbilled, and viewable', async () => {
    const { getDb, chargeLines, eq, cc } = await m()
    const db = getDb()
    const base = { patientId: PID_LAB, source: 'pharmacy' as const, priceSource: 'pharmacy' as const, itemCode: 'J3490', itemName: 'Test drug', serviceDate: DAY,
      quantity: 2, unitPricePaise: 1500, taxablePaise: 3000, gstRateBp: 500, hsnSac: '3004', createdByName: 'TEST-SP4' }
    const [a] = await db.insert(chargeLines).values(base).returning()
    const [b] = await db.insert(chargeLines).values({ ...base, quantity: 1, taxablePaise: 1500 }).returning()
    // a line with a context is not a pharmacy-view line
    const r = await cc.captureChargeLine({ context: { encounterId: fx.labEncounterId }, serviceId: fx.consultId, quantity: 1, serviceDate: DAY, billTo: 'patient' }, crc, NOW)
    expect(r.ok).toBe(true)
    const rows = await cc.listUnbilledPharmacyPatients()
    expect(rows.find((x) => x.patientId === PID_LAB)).toEqual({ patientId: PID_LAB, patientName: 'Test SP4 Lab', uhid: null, lineCount: 2, taxablePaise: 4500 })
    const view = await cc.getPharmacyCaptureView(PID_LAB)
    expect(view).toMatchObject({ patientId: PID_LAB, patientName: 'Test SP4 Lab', uhid: null })
    expect(view!.lines.map((l) => l.id)).toEqual([a.id, b.id])
    // once both are voided (or invoiced) the patient drops off the unbilled list but the view still opens
    await db.update(chargeLines).set({ status: 'void', voidReason: 'test', voidedByName: 'TEST-SP4', voidedAt: NOW }).where(eq(chargeLines.patientId, PID_LAB))
    expect((await cc.listUnbilledPharmacyPatients()).find((x) => x.patientId === PID_LAB)).toBeUndefined()
    expect((await cc.getPharmacyCaptureView(PID_LAB))!.lines).toHaveLength(2)
    expect(await cc.getPharmacyCaptureView('TEST-SP4-NOBODY')).toBeNull()
  })
})
