import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'

// SP4 Task 10: gapless numbering and the invoice lifecycle against the real DB. Every finalise
// passes `now` in 2099, so documents number in the test-only 2099-00 financial year.
const NOW = new Date('2099-06-01T06:00:00Z')
const DAY = '2099-06-01'

describe.skipIf(!process.env.DATABASE_URL)('invoices (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PIDS = Array.from({ length: 6 }, (_, i) => `TEST-SP4-${RUN}-${i}`)
  const PID = PIDS[0]
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const billing: Session = { role: 'billing', name: `TEST-SP4-${RUN}`, userId: null }
  const fx = { departmentId: 0, serviceId: 0, payerId: 0, providerId: 0, encounters: [] as number[], admissionId: 0 }
  const encounterOf = new Map<string, number>()
  let savedSettings: Record<string, unknown> | null = null

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    inv: await import('@/lib/queries/invoices'),
    nums: await import('@/lib/queries/document-numbers'),
  })

  const SETTINGS = { legalName: 'Test SP4 Hospital', stateCode: 'IN-KA', gstin: '29AAGCB7383J1Z4', address: 'MG Road', placeOfSupplyMode: 'location_of_service' as const }

  beforeAll(async () => {
    const { getDb, departments, providers, serviceCatalog, patients, encounters, payers, admissions, billingSettings, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    await db.update(billingSettings).set(SETTINGS).where(eq(billingSettings.id, 1))
    const [prov] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    fx.providerId = prov.id
    const [dep] = await db.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [svc] = await db.insert(serviceCatalog).values({ code: CODE, name: 'Test consult', departmentId: dep.id, category: 'consultation', hsnSac: '999312' }).returning()
    fx.serviceId = svc.id
    const [payer] = await db.insert(payers).values({ name: `Test SP4 Payer ${RUN}`, payerId: CODE, stateCode: 'IN-MH' }).returning()
    fx.payerId = payer.id
    for (const id of PIDS) {
      await db.insert(patients).values({ id, name: `Test SP4 Invoice ${id.slice(-1)}`, dob: '1990-01-01', uhid: `${CODE}${id.slice(-1)}`, stateCode: 'IN-KA', addressLine1: '1 Test Street', phone: '9999999999' })
      const [e] = await db.insert(encounters).values({ patientId: id, encounterType: 'opd', encounterDate: DAY, providerId: prov.id, checkedInByName: 'TEST-SP4' }).returning()
      fx.encounters.push(e.id)
      encounterOf.set(id, e.id)
    }
    const [adm] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: prov.id, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.admissionId = adm.id
  })

  afterEach(async () => {
    const { getDb, billingSettings, eq } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    await purgeBillingFixtures(PIDS)
    await getDb().update(billingSettings).set(SETTINGS).where(eq(billingSettings.id, 1))
  })

  afterAll(async () => {
    const { getDb, departments, serviceCatalog, patients, encounters, payers, admissions, billingSettings, auditLog, eq, inArray } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures(PIDS)
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db.delete(admissions).where(eq(admissions.id, fx.admissionId))
    await db.delete(encounters).where(inArray(encounters.id, fx.encounters))
    await db.delete(patients).where(inArray(patients.id, PIDS))
    await db.delete(payers).where(eq(payers.id, fx.payerId))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, fx.serviceId))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
    await db.delete(auditLog).where(inArray(auditLog.patientId, PIDS))
  })

  async function line(over: Record<string, unknown> = {}, patientId = PID) {
    const { getDb, chargeLines } = await m()
    const [r] = await getDb().insert(chargeLines).values({
      patientId, encounterId: encounterOf.get(patientId)!, source: 'manual', serviceId: fx.serviceId, itemCode: CODE, itemName: 'Test consult',
      serviceCategory: 'consultation', serviceDate: DAY, quantity: 1, unitPricePaise: 50000, priceSource: 'base', taxablePaise: 50000,
      gstRateBp: 0, hsnSac: '999312', createdByName: 'TEST-SP4', ...over,
    } as never).returning()
    return r
  }

  async function draft(lineIds: number[]) {
    const { inv } = await m()
    const r = await inv.createDraftInvoice(lineIds, billing)
    if (!r.ok) throw new Error(`draft failed: ${r.error}`)
    return r.invoiceId
  }

  it('finalises with consecutive numbers in the 2099-00 series', async () => {
    const { inv } = await m()
    const a = await draft([(await line()).id])
    const b = await draft([(await line({ serviceDate: '2099-05-31' })).id])
    expect(await inv.finaliseInvoice(a, billing, NOW)).toEqual({ ok: true, invoiceNumber: 'INV/99-00/000001' })
    expect(await inv.finaliseInvoice(b, billing, NOW)).toEqual({ ok: true, invoiceNumber: 'INV/99-00/000002' })
    const detail = await inv.getInvoice(a)
    expect(detail).toMatchObject({ status: 'finalised', invoiceNumber: 'INV/99-00/000001', financialYear: '2099-00', invoiceDate: DAY,
      documentTitle: 'Bill of Supply', supplyType: 'intra', totalPaise: 50000, patientName: 'Test SP4 Invoice 0', uhid: `${CODE}0`, creditNote: null })
    expect(detail!.lines).toHaveLength(1)
    expect(detail!.lines[0]).toMatchObject({ lineNo: 1, itemCode: CODE, totalPaise: 50000 })
  })

  it('concurrent finalisations get consecutive numbers', async () => {
    const { inv } = await m()
    const ids: number[] = []
    for (const pid of PIDS.slice(1, 6)) ids.push(await draft([(await line({}, pid)).id]))
    const results = await Promise.all(ids.map((id) => inv.finaliseInvoice(id, billing, NOW)))
    const numbers = results.map((r) => (r.ok ? r.invoiceNumber : r.error)).sort()
    expect(numbers).toEqual(['000001', '000002', '000003', '000004', '000005'].map((n) => `INV/99-00/${n}`))
  })

  it('a finalise that throws after numbering leaves no gap', async () => {
    const { inv } = await m()
    const id = await draft([(await line()).id])
    await expect(inv.finaliseInvoice(id, billing, NOW, { afterNumber: () => { throw new Error('boom') } })).rejects.toThrow('boom')
    const after = await inv.getInvoice(id)
    expect(after!.status).toBe('draft')
    expect(after!.invoiceNumber).toBeNull()
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: true, invoiceNumber: 'INV/99-00/000001' })
  })

  it('finalise just after IST midnight on 1 April uses the new series', async () => {
    const { inv } = await m()
    const id = await draft([(await line({ serviceDate: '2099-03-31' })).id])
    const r = await inv.finaliseInvoice(id, billing, new Date('2099-03-31T18:40:00Z'))
    expect(r).toEqual({ ok: true, invoiceNumber: 'INV/99-00/000001' })
    expect((await inv.getInvoice(id))!.invoiceDate).toBe('2099-04-01')
  })

  it('splits CGST/SGST intra-state and IGST for a recipient-state payer elsewhere', async () => {
    const { inv, getDb, billingSettings, eq } = await m()
    const intra = await draft([(await line({ gstRateBp: 1800, taxablePaise: 100001 })).id])
    expect((await inv.finaliseInvoice(intra, billing, NOW)).ok).toBe(true)
    const d1 = await inv.getInvoice(intra)
    expect(d1).toMatchObject({ supplyType: 'intra', placeOfSupplyStateCode: 'IN-KA', documentTitle: 'Tax Invoice', taxablePaise: 100001, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118001 })
    expect(d1!.lines[0]).toMatchObject({ cgstRateBp: 900, sgstRateBp: 900, igstRateBp: 0 })

    await getDb().update(billingSettings).set({ placeOfSupplyMode: 'recipient_state' }).where(eq(billingSettings.id, 1))
    const inter = await draft([(await line({ gstRateBp: 1800, taxablePaise: 100000, payerId: fx.payerId })).id])
    expect((await inv.finaliseInvoice(inter, billing, NOW)).ok).toBe(true)
    const d2 = await inv.getInvoice(inter)
    expect(d2).toMatchObject({ supplyType: 'inter', placeOfSupplyStateCode: 'IN-MH', payerId: fx.payerId, igstPaise: 18000, cgstPaise: 0, totalPaise: 118000 })
    expect(d2!.snapshot!.payer).toMatchObject({ id: fx.payerId, stateCode: 'IN-MH' })
  })

  it('refuses taxable lines without a hospital GSTIN, and incomplete settings', async () => {
    const { inv, getDb, billingSettings, eq } = await m()
    const id = await draft([(await line({ gstRateBp: 500 })).id])
    await getDb().update(billingSettings).set({ gstin: null }).where(eq(billingSettings.id, 1))
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: false, error: 'taxable_without_gstin' })
    await getDb().update(billingSettings).set({ legalName: null }).where(eq(billingSettings.id, 1))
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: false, error: 'settings_incomplete' })
    // An all-exempt bill without a GSTIN is a plain Bill.
    await getDb().update(billingSettings).set({ legalName: 'Test SP4 Hospital' }).where(eq(billingSettings.id, 1))
    const exempt = await draft([(await line()).id])
    expect((await inv.finaliseInvoice(exempt, billing, NOW)).ok).toBe(true)
    expect((await inv.getInvoice(exempt))!.documentTitle).toBe('Bill')
  })

  it('mixed payers or contexts cannot share a draft; taken or missing lines are refused', async () => {
    const { inv } = await m()
    const a = await line()
    const b = await line({ payerId: fx.payerId })
    expect(await inv.createDraftInvoice([a.id, b.id], billing)).toEqual({ ok: false, error: 'mixed_lines' })
    const c = await line({}, PIDS[1])
    expect(await inv.createDraftInvoice([a.id, c.id], billing)).toEqual({ ok: false, error: 'mixed_lines' })
    const ipd = await line({ encounterId: null, admissionId: fx.admissionId })
    expect(await inv.createDraftInvoice([a.id, ipd.id], billing)).toEqual({ ok: false, error: 'mixed_lines' })
    expect(await inv.createDraftInvoice([a.id, 2_147_483_000], billing)).toEqual({ ok: false, error: 'lines_not_found' })
    await draft([a.id])
    expect(await inv.createDraftInvoice([a.id], billing)).toEqual({ ok: false, error: 'lines_not_available' })
    const pharmacy1 = await line({ encounterId: null, source: 'pharmacy', serviceId: null, serviceCategory: null, priceSource: 'pharmacy' })
    const pharmacy2 = await line({ encounterId: null, source: 'pharmacy', serviceId: null, serviceCategory: null, priceSource: 'pharmacy' })
    expect((await inv.createDraftInvoice([pharmacy1.id, pharmacy2.id], billing)).ok).toBe(true)
  })

  it('an admission draft takes the admission context; drafts show an estimated split', async () => {
    const { inv } = await m()
    const id = await draft([(await line({ encounterId: null, admissionId: fx.admissionId, gstRateBp: 1800 })).id])
    const d = await inv.getInvoice(id)
    expect(d).toMatchObject({ status: 'draft', admissionId: fx.admissionId, encounterId: null, invoiceNumber: null })
    expect(d!.lines[0]).toMatchObject({ lineNo: 1, cgstPaise: 4500, sgstPaise: 4500, totalPaise: 59000 })
  })

  it('discard releases the lines; a discarded draft cannot be finalised', async () => {
    const { inv, getDb, chargeLines, eq } = await m()
    const l = await line()
    const id = await draft([l.id])
    expect(await inv.discardDraftInvoice(id, billing)).toEqual({ ok: true })
    const [row] = await getDb().select().from(chargeLines).where(eq(chargeLines.id, l.id))
    expect(row.invoiceId).toBeNull()
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: false, error: 'not_draft' })
    expect(await inv.discardDraftInvoice(id, billing)).toEqual({ ok: false, error: 'not_draft' })
    expect(await inv.discardDraftInvoice(2_147_483_000, billing)).toEqual({ ok: false, error: 'not_found' })
    expect((await inv.createDraftInvoice([l.id], billing)).ok).toBe(true)
  })

  it('a draft whose lines were all voided is empty', async () => {
    const { inv, getDb, chargeLines, eq } = await m()
    const l = await line()
    const id = await draft([l.id])
    await getDb().update(chargeLines).set({ status: 'void', voidReason: 'Test', invoiceId: null }).where(eq(chargeLines.id, l.id))
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: false, error: 'empty' })
  })

  it('cancel issues a credit note for the full value and frees the lines for a new invoice', async () => {
    const { inv, getDb, chargeLines, eq } = await m()
    const l = await line({ gstRateBp: 1800 })
    const id = await draft([l.id])
    await inv.finaliseInvoice(id, billing, NOW)
    expect(await inv.cancelInvoice(id, 'Wrong patient selected', billing, NOW)).toEqual({ ok: true, creditNoteNumber: 'CRN/99-00/000001' })
    const d = await inv.getInvoice(id)
    expect(d).toMatchObject({ status: 'cancelled', invoiceNumber: 'INV/99-00/000001', cancelledByName: billing.name })
    expect(d!.creditNote).toMatchObject({ creditNoteNumber: 'CRN/99-00/000001', totalPaise: d!.totalPaise, reason: 'Wrong patient selected' })
    expect(d!.lines).toHaveLength(1)
    const [row] = await getDb().select().from(chargeLines).where(eq(chargeLines.id, l.id))
    expect(row).toMatchObject({ status: 'captured', invoiceId: null })
    const again = await draft([l.id])
    expect(await inv.finaliseInvoice(again, billing, NOW)).toEqual({ ok: true, invoiceNumber: 'INV/99-00/000002' })
    expect(await inv.cancelInvoice(id, 'Second try at this', billing, NOW)).toEqual({ ok: false, error: 'not_finalised' })
  })

  it('a finalised invoice cannot be finalised or discarded again', async () => {
    const { inv } = await m()
    const id = await draft([(await line()).id])
    await inv.finaliseInvoice(id, billing, NOW)
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: false, error: 'not_draft' })
    expect(await inv.discardDraftInvoice(id, billing)).toEqual({ ok: false, error: 'not_draft' })
    expect(await inv.cancelInvoice(2_147_483_000, 'Missing invoice', billing, NOW)).toEqual({ ok: false, error: 'not_found' })
  })

  it('snapshot holds no aadhaar, phone, email or dob keys', async () => {
    const { inv } = await m()
    const id = await draft([(await line()).id])
    await inv.finaliseInvoice(id, billing, NOW)
    const d = await inv.getInvoice(id)
    expect(JSON.stringify(d!.snapshot)).not.toMatch(/aadhaar|phone|email|dob|9999999999/i)
    expect(d!.snapshot).toMatchObject({
      hospital: { legalName: 'Test SP4 Hospital', gstin: '29AAGCB7383J1Z4', stateCode: 'IN-KA', gstStateCode: '29' },
      patient: { id: PID, name: 'Test SP4 Invoice 0', uhid: `${CODE}0`, addressLine1: '1 Test Street', stateCode: 'IN-KA' },
      payer: null,
      context: { encounterId: encounterOf.get(PID), admissionId: null },
    })
  })

  it('audit details carry ids, numbers and paise only', async () => {
    const { inv, getDb, auditLog, eq } = await m()
    const id = await draft([(await line()).id])
    await inv.finaliseInvoice(id, billing, NOW)
    await inv.cancelInvoice(id, 'SECRET-REASON', billing, NOW)
    const rows = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, PID))).map((a) => `${a.action}|${a.details}`)
    expect(rows).toContain(`billing: created draft invoice|invoice=${id} lines=1`)
    expect(rows).toContain(`billing: finalised invoice|invoice=${id} number=INV/99-00/000001 total=50000`)
    expect(rows).toContain(`billing: cancelled invoice by credit note|invoice=${id} credit_note=CRN/99-00/000001`)
    expect(rows.join()).not.toContain('SECRET')
  })

  it('lists invoices by status and number/UHID, and the captured lines of a context', async () => {
    const { inv } = await m()
    const l1 = await line()
    const id = await draft([l1.id])
    await inv.finaliseInvoice(id, billing, NOW)
    const l2 = await line({ serviceDate: '2099-05-31' })
    const byNumber = await inv.listInvoices({ q: 'INV/99-00/00000' })
    expect(byNumber.rows.map((r) => r.id)).toContain(id)
    const byUhid = await inv.listInvoices({ q: `${CODE}0`, status: 'finalised' })
    expect(byUhid).toMatchObject({ total: 1, rows: [{ id, invoiceNumber: 'INV/99-00/000001', patientName: 'Test SP4 Invoice 0', uhid: `${CODE}0`, totalPaise: 50000 }] })
    expect((await inv.listCapturedLinesForContext({ encounterId: encounterOf.get(PID)! })).map((r) => r.id)).toEqual([l2.id])
  })

  it('allocateDocumentNumber maps an exhausted series to SeriesExhaustedError', async () => {
    const { nums, getDb, documentCounters } = await m()
    await getDb().insert(documentCounters).values({ series: 'refund', financialYear: '2099-00', lastValue: 999_999 })
    await expect(getDb().transaction((tx) => nums.allocateDocumentNumber(tx, 'refund', '2099-00'))).rejects.toBeInstanceOf(nums.SeriesExhaustedError)
  })

  it('series_exhausted refuses the finalise and leaves the draft', async () => {
    const { inv, getDb, documentCounters } = await m()
    await getDb().insert(documentCounters).values({ series: 'invoice', financialYear: '2099-00', lastValue: 999_999 })
    const id = await draft([(await line()).id])
    expect(await inv.finaliseInvoice(id, billing, NOW)).toEqual({ ok: false, error: 'series_exhausted' })
    expect((await inv.getInvoice(id))!.status).toBe('draft')
  })
})
