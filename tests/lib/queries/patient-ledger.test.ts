import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'

// SP4 Task 12: advances, receipts, refunds and the running ledger against the real DB (2099 dates).
const NOW = new Date('2099-06-01T06:00:00Z')
const DAY = '2099-06-01'

describe.skipIf(!process.env.DATABASE_URL)('patient ledger (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const PID_DEL = `TEST-SP4-${RUN}-D`
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const desk: Session = { role: 'frontdesk', name: `TEST-SP4-${RUN}-desk`, userId: null }
  const billing: Session = { role: 'billing', name: `TEST-SP4-${RUN}-billing`, userId: null }
  const fx = { departmentId: 0, consultId: 0, procId: 0, rates: [] as number[], providerId: 0, encounterId: 0, admissionId: 0, otherAdmissionId: 0, charges: [] as number[] }
  let savedSettings: Record<string, unknown> | null = null

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    pl: await import('@/lib/queries/patient-ledger'),
    inv: await import('@/lib/queries/invoices'),
  })

  beforeAll(async () => {
    const { getDb, departments, providers, serviceCatalog, tariffRates, patients, encounters, admissions, billingSettings, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    await db.update(billingSettings).set({ legalName: 'Test SP4 Hospital', stateCode: 'IN-KA', gstin: null, ipdDepositThresholdPaise: 0 }).where(eq(billingSettings.id, 1))
    const [prov] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    fx.providerId = prov.id
    const [dep] = await db.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [c] = await db.insert(serviceCatalog).values({ code: `${CODE}C`, name: 'Test consult', departmentId: dep.id, category: 'consultation', hsnSac: '999312' }).returning()
    const [p] = await db.insert(serviceCatalog).values({ code: `${CODE}P`, name: 'Test procedure', departmentId: dep.id, category: 'procedure', hsnSac: '999312' }).returning()
    fx.consultId = c.id
    fx.procId = p.id
    fx.rates.push((await db.insert(tariffRates).values({ serviceId: p.id, scope: 'base', amountPaise: 50000, validFrom: '2099-01-01', createdByName: 'TEST-SP4' }).returning())[0].id)
    await db.insert(patients).values([
      { id: PID, name: `Test SP4 Ledger ${RUN}`, dob: '1990-01-01', uhid: `${CODE}L` },
      { id: PID_DEL, name: 'Test SP4 Ledger Delete', dob: '1990-01-01' },
    ])
    const [e] = await db.insert(encounters).values({ patientId: PID, encounterType: 'opd', encounterDate: DAY, providerId: prov.id, checkedInByName: 'TEST-SP4' }).returning()
    fx.encounterId = e.id
    const [a] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: prov.id, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.admissionId = a.id
    const [o] = await db.insert(admissions).values({ patientId: PID_DEL, attendingProviderId: prov.id, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.otherAdmissionId = o.id
  })

  afterEach(async () => {
    const { getDb, charges, inArray } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    await purgeBillingFixtures([PID, PID_DEL])
    if (fx.charges.length) await getDb().delete(charges).where(inArray(charges.id, fx.charges.splice(0)))
  })

  afterAll(async () => {
    const { getDb, departments, serviceCatalog, tariffRates, patients, encounters, admissions, billingSettings, auditLog, eq, inArray } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures([PID, PID_DEL])
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db.delete(admissions).where(inArray(admissions.id, [fx.admissionId, fx.otherAdmissionId]))
    await db.delete(encounters).where(inArray(encounters.patientId, [PID, PID_DEL]))
    await db.delete(patients).where(inArray(patients.id, [PID, PID_DEL]))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rates))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [fx.consultId, fx.procId]))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
    await db.delete(auditLog).where(inArray(auditLog.patientId, [PID, PID_DEL]))
  })

  async function finalisedInvoice(taxablePaise: number, quantity = 1) {
    const { getDb, chargeLines, inv } = await m()
    const [l] = await getDb().insert(chargeLines).values({
      patientId: PID, encounterId: fx.encounterId, source: 'manual', serviceId: fx.consultId, itemCode: `${CODE}C`, itemName: 'Test consult',
      serviceCategory: 'consultation', serviceDate: DAY, quantity, unitPricePaise: taxablePaise / quantity, priceSource: 'base', taxablePaise,
      gstRateBp: 0, hsnSac: '999312', createdByName: 'TEST-SP4',
    }).returning()
    const d = await inv.createDraftInvoice([l.id], billing)
    if (!d.ok) throw new Error(d.error)
    const f = await inv.finaliseInvoice(d.invoiceId, billing, NOW)
    if (!f.ok) throw new Error(f.error)
    return d.invoiceId
  }

  const pay = async (over: Record<string, unknown> = {}, at = NOW) => {
    const { pl } = await m()
    return pl.recordPayment({ patientId: PID, kind: 'advance', mode: 'cash', amountPaise: 100000, ...over } as never, desk, at)
  }

  it('advance then invoice then receipt gives the running balance', async () => {
    const { pl } = await m()
    const adv = await pay({ amountPaise: 30000 }, new Date('2099-06-01T05:00:00Z'))
    expect(adv).toMatchObject({ ok: true, receiptNumber: 'RCT/99-00/000001' })
    const invoiceId = await finalisedInvoice(50000)
    const rct = await pay({ kind: 'receipt', invoiceId, mode: 'upi', reference: 'UTR412345678901', amountPaise: 20000 }, new Date('2099-06-01T07:00:00Z'))
    expect(rct).toMatchObject({ ok: true, receiptNumber: 'RCT/99-00/000002' })
    const ledger = await pl.getPatientLedger(PID)
    expect(ledger!.patient).toEqual({ id: PID, name: `Test SP4 Ledger ${RUN}`, uhid: `${CODE}L` })
    expect(ledger!.activeAdmissionId).toBe(fx.admissionId)
    expect(ledger!.ledger.rows.map((r) => [r.kind, r.amountPaise, r.balancePaise])).toEqual([
      ['advance', 30000, -30000], ['invoice', 50000, 20000], ['receipt', 20000, 0],
    ])
    expect(ledger!.ledger.summary).toMatchObject({ invoicedPaise: 50000, receivedPaise: 50000, balancePaise: 0, outstandingPaise: 0 })
    expect(await pl.getPatientLedger('TEST-SP4-missing')).toBeNull()
  })

  it('ledger sum above 2^31 is exact', async () => {
    const { pl } = await m()
    await finalisedInvoice(2_000_000_000, 2)
    await finalisedInvoice(2_000_000_000, 2)
    const ledger = await pl.getPatientLedger(PID)
    expect(ledger!.ledger.summary.invoicedPaise).toBe(4_000_000_000)
    expect(ledger!.ledger.summary.outstandingPaise).toBe(4_000_000_000)
  })

  it('unbilled is the SQL sum of captured lines, read exactly', async () => {
    const { pl, getDb, chargeLines } = await m()
    for (let i = 0; i < 2; i++) {
      await getDb().insert(chargeLines).values({
        patientId: PID, encounterId: fx.encounterId, source: 'manual', serviceId: fx.consultId, itemCode: `${CODE}C`, itemName: 'Test consult',
        serviceCategory: 'consultation', serviceDate: DAY, quantity: 2, unitPricePaise: 1_000_000_000, priceSource: 'base', taxablePaise: 2_000_000_000,
        gstRateBp: 0, hsnSac: '999312', createdByName: 'TEST-SP4',
      })
    }
    expect((await pl.getPatientLedger(PID))!.unbilledPaise).toBe(4_000_000_000)
  })

  it('refund cannot exceed the credit balance', async () => {
    const { pl } = await m()
    const adv = await pay({ amountPaise: 100000 })
    if (!adv.ok) throw new Error('advance failed')
    const tooMuch = await pl.issueRefund({ patientId: PID, againstPaymentId: adv.paymentId, mode: 'cash', amountPaise: 100001, reason: 'Discharged early' }, billing, NOW)
    expect(tooMuch).toEqual({ ok: false, error: 'exceeds_credit', creditPaise: 100000 })
    const ok = await pl.issueRefund({ patientId: PID, againstPaymentId: adv.paymentId, mode: 'neft', reference: 'NEFT123456', amountPaise: 60000, reason: 'Discharged early' }, billing, NOW)
    expect(ok).toEqual({ ok: true, refundNumber: 'RFD/99-00/000001' })
    expect((await pl.getPatientLedger(PID))!.ledger.summary.creditBalancePaise).toBe(40000)
  })

  it('refunds and payments check ownership of the receipt, admission and invoice', async () => {
    const { pl, getDb, patientPayments } = await m()
    const [other] = await getDb().insert(patientPayments).values({
      receiptNumber: `RCT/99-00/X${RUN}`, kind: 'advance', patientId: PID_DEL, mode: 'cash', amountPaise: 500, financialYear: '2099-00', receiptDate: DAY, receivedByName: 'TEST-SP4',
    }).returning()
    expect(await pl.issueRefund({ patientId: PID, againstPaymentId: other.id, mode: 'cash', amountPaise: 1, reason: 'Wrong receipt' }, billing, NOW))
      .toEqual({ ok: false, error: 'payment_mismatch' })
    expect(await pay({ admissionId: fx.otherAdmissionId })).toEqual({ ok: false, error: 'admission_mismatch' })
    expect(await pay({ kind: 'receipt', invoiceId: 2_147_483_000 })).toEqual({ ok: false, error: 'invoice_not_payable' })
    expect(await pay({ patientId: 'TEST-SP4-missing' })).toEqual({ ok: false, error: 'patient_not_found' })
    expect(await pl.issueRefund({ patientId: 'TEST-SP4-missing', mode: 'cash', amountPaise: 1, reason: 'Missing patient' }, billing, NOW))
      .toEqual({ ok: false, error: 'patient_not_found' })
  })

  it('advances count toward the admission deposit used by capture', async () => {
    const { getDb, billingSettings, eq } = await m()
    const cc = await import('@/lib/queries/charge-capture')
    await getDb().update(billingSettings).set({ ipdDepositThresholdPaise: 200000 }).where(eq(billingSettings.id, 1))
    try {
      const req = { context: { admissionId: fx.admissionId }, serviceId: fx.procId, quantity: 1, serviceDate: DAY, billTo: 'patient' as const }
      const crc: Session = { role: 'crc', name: desk.name, userId: null }
      const blocked = await cc.captureChargeLine(req, crc, NOW)
      expect(!blocked.ok && blocked.violations!.map((v) => v.code)).toContain('deposit_below_threshold')
      expect((await pay({ admissionId: fx.admissionId, amountPaise: 200000 })).ok).toBe(true)
      expect((await cc.captureChargeLine(req, crc, NOW)).ok).toBe(true)
    } finally {
      await getDb().update(billingSettings).set({ ipdDepositThresholdPaise: 0 }).where(eq(billingSettings.id, 1))
    }
  })

  it('legacy charges are listed flagged and excluded from outstanding; a pharmacy-linked one is not listed', async () => {
    const { pl, getDb, charges, chargeLines } = await m()
    const legacy = async (amountCents: number) => {
      const [c] = await getDb().insert(charges).values({
        patientId: PID, providerName: 'Test', dateOfService: DAY, diagnosisCodes: [], procedureCodes: [], amountCents, status: 'draft',
      }).returning()
      fx.charges.push(c.id)
      return c
    }
    const plain = await legacy(12345)
    const linked = await legacy(500)
    await getDb().insert(chargeLines).values({
      patientId: PID, source: 'pharmacy', itemCode: 'RX', itemName: 'Test drug', serviceDate: DAY, quantity: 1, unitPricePaise: 500, priceSource: 'pharmacy',
      taxablePaise: 500, gstRateBp: 500, hsnSac: '3004', legacyChargeId: linked.id, createdByName: 'TEST-SP4',
    })
    const ledger = await pl.getPatientLedger(PID)
    expect(ledger!.legacyCharges).toEqual([{ id: plain.id, dateOfService: DAY, amountPaise: 12345, status: 'draft', legacy: true }])
    expect(ledger!.ledger.summary.outstandingPaise).toBe(0)
    expect(ledger!.unbilledPaise).toBe(500)
  })

  it('a full receipt or refund series is a friendly refusal, nothing written', async () => {
    const { pl, getDb, documentCounters, patientPayments, eq } = await m()
    const adv = await pay({ amountPaise: 1000 })
    if (!adv.ok) throw new Error('advance failed')
    await getDb().update(documentCounters).set({ lastValue: 999_999 }).where(eq(documentCounters.series, 'receipt'))
    expect(await pay({ amountPaise: 500 })).toEqual({ ok: false, error: 'series_exhausted' })
    expect(await getDb().select().from(patientPayments).where(eq(patientPayments.patientId, PID))).toHaveLength(1)
    await getDb().insert(documentCounters).values({ series: 'refund', financialYear: '2099-00', lastValue: 999_999 })
    expect(await pl.issueRefund({ patientId: PID, mode: 'cash', amountPaise: 100, reason: 'Discharged early' }, billing, NOW))
      .toEqual({ ok: false, error: 'series_exhausted' })
  })

  it('lists the patient\'s finalised invoices for the cash desk', async () => {
    const { pl } = await m()
    const id = await finalisedInvoice(50000)
    expect(await pl.listPayableInvoices(PID)).toEqual([{ id, invoiceNumber: 'INV/99-00/000001', totalPaise: 50000 }])
  })

  it('audit details carry no reference', async () => {
    const { getDb, auditLog, eq } = await m()
    const r = await pay({ mode: 'upi', reference: 'UTR412345678901', amountPaise: 7000 })
    if (!r.ok) throw new Error('payment failed')
    const rows = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, PID))).map((a) => `${a.action}|${a.details}`)
    expect(rows).toContain(`billing: recorded advance|receipt=${r.receiptNumber} mode=upi amount=7000`)
    expect(rows.join()).not.toContain('UTR412345678901')
  })

  it('getReceipt and findPatientForCashDesk', async () => {
    const { pl } = await m()
    const r = await pay({ amountPaise: 4200 })
    if (!r.ok) throw new Error('payment failed')
    expect(await pl.getReceipt(r.paymentId)).toMatchObject({ id: r.paymentId, receiptNumber: r.receiptNumber, amountPaise: 4200, patientName: `Test SP4 Ledger ${RUN}`, uhid: `${CODE}L` })
    expect(await pl.getReceipt(2_147_483_000)).toBeNull()
    expect(await pl.findPatientForCashDesk(`${CODE}L`)).toEqual([{ id: PID, name: `Test SP4 Ledger ${RUN}`, uhid: `${CODE}L` }])
    expect((await pl.findPatientForCashDesk(PID))[0].id).toBe(PID)
    expect((await pl.findPatientForCashDesk(`Test SP4 Ledger ${RUN}`)).map((p) => p.id)).toEqual([PID])
    expect(await pl.findPatientForCashDesk('   ')).toEqual([])
  })

  it('deletePatient refuses a patient with a receipt and deletes one with only drafts', { timeout: 30000 }, async () => {
    const { getDb, patients, chargeLines, invoices, admissions, eq, inArray } = await m()
    const { deletePatient, PatientHasFinancialRecordsError } = await import('@/lib/queries/patients')
    const db = getDb()
    // A receipt: refused before anything is deleted.
    const { pl } = await m()
    const r = await pl.recordPayment({ patientId: PID_DEL, kind: 'advance', mode: 'cash', amountPaise: 100 }, desk, NOW)
    expect(r.ok).toBe(true)
    await expect(deletePatient(PID_DEL)).rejects.toBeInstanceOf(PatientHasFinancialRecordsError)
    expect(await db.select().from(patients).where(eq(patients.id, PID_DEL))).toHaveLength(1)
    expect(await db.select().from(admissions).where(eq(admissions.id, fx.otherAdmissionId))).toHaveLength(1)
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    await purgeBillingFixtures([PID_DEL])

    // Only drafts and captured lines: deleted.
    const [l] = await db.insert(chargeLines).values({
      patientId: PID_DEL, admissionId: fx.otherAdmissionId, source: 'manual', serviceId: fx.consultId, itemCode: `${CODE}C`, itemName: 'Test consult',
      serviceCategory: 'consultation', serviceDate: DAY, quantity: 1, unitPricePaise: 100, priceSource: 'base', taxablePaise: 100, gstRateBp: 0, hsnSac: '999312', createdByName: 'TEST-SP4',
    }).returning()
    const d = await (await m()).inv.createDraftInvoice([l.id], billing)
    expect(d.ok).toBe(true)
    expect(await deletePatient(PID_DEL)).toBe(true)
    expect(await db.select().from(patients).where(eq(patients.id, PID_DEL))).toEqual([])
    expect(await db.select().from(invoices).where(inArray(invoices.patientId, [PID_DEL]))).toEqual([])
    // Recreate the fixture rows the remaining cleanup expects.
    await db.insert(patients).values({ id: PID_DEL, name: 'Test SP4 Ledger Delete', dob: '1990-01-01' })
    const [o] = await db.insert(admissions).values({ patientId: PID_DEL, attendingProviderId: fx.providerId, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.otherAdmissionId = o.id
  })
})
