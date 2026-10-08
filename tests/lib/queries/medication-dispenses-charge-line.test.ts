import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'

// SP4 Task 13: billing a dispense writes the legacy charge AND one pharmacy charge line, atomically.
describe.skipIf(!process.env.DATABASE_URL)('pharmacy dispense charge line (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const fx = { medId: 0, dispenses: [] as number[], charges: [] as number[], admissionId: 0, providerId: 0 }
  let savedSettings: Record<string, unknown> | null = null

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    md: await import('@/lib/queries/medication-dispenses'),
  })

  beforeAll(async () => {
    const { getDb, medications, medicationInventory, patients, providers, billingSettings, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    await db.update(billingSettings).set({ pharmacyGstRateBp: 1200, pharmacyHsn: '30049099' }).where(eq(billingSettings.id, 1))
    const [prov] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    fx.providerId = prov.id
    const [med] = await db.insert(medications).values({ name: `Test SP4 Med ${RUN}`, medicationClass: 'Test', form: 'tablet' }).returning()
    fx.medId = med.id
    await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 100, reorderThreshold: 5, unit: 'tablets' })
    await db.insert(patients).values({ id: PID, name: 'Test SP4 Pharmacy', dob: '1990-01-01' })
  })

  afterEach(async () => {
    const { getDb, medicationDispenses, charges, admissions, inArray, eq } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures([PID])
    if (fx.dispenses.length) await db.delete(medicationDispenses).where(inArray(medicationDispenses.id, fx.dispenses.splice(0)))
    if (fx.charges.length) await db.delete(charges).where(inArray(charges.id, fx.charges.splice(0)))
    if (fx.admissionId) { await db.delete(admissions).where(eq(admissions.id, fx.admissionId)); fx.admissionId = 0 }
  })

  afterAll(async () => {
    const { getDb, medications, medicationInventory, patients, billingSettings, eq } = await m()
    const db = getDb()
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db.delete(medicationInventory).where(eq(medicationInventory.medicationId, fx.medId))
    await db.delete(medications).where(eq(medications.id, fx.medId))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  async function dispense(quantity = 6, dispensedAt = new Date('2099-06-01T06:00:00Z')) {
    const { getDb, medicationDispenses } = await m()
    const [d] = await getDb().insert(medicationDispenses).values({ patientId: PID, medicationId: fx.medId, quantity, dispensedByName: 'Test Pharmacist', dispensedAt }).returning()
    fx.dispenses.push(d.id)
    return d
  }

  async function bill(d: { id: number; quantity: number }, serviceDate = '2099-06-01') {
    const { md } = await m()
    const r = await md.createChargeForDispense({
      dispenseId: d.id, patientId: PID, providerName: 'Dr Test', dateOfService: serviceDate, serviceDate, createdByName: 'Test Pharmacist',
      diagnosisCode: { code: 'I10', description: 'Hypertension' },
      procedureCode: { code: 'J3490', description: 'Unclassified drugs - Sertraline', units: d.quantity, chargeCents: 250 },
      amountCents: d.quantity * 250,
    })
    if (r.ok && r.chargeId) fx.charges.push(r.chargeId)
    return r
  }

  async function linesOf(dispenseId: number) {
    const { getDb, chargeLines, eq } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, dispenseId))
  }

  it('creates the legacy charge and one pharmacy charge line in one transaction', async () => {
    const d = await dispense()
    const r = await bill(d)
    expect(r).toMatchObject({ ok: true })
    const lines = await linesOf(d.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      patientId: PID, source: 'pharmacy', priceSource: 'pharmacy', serviceId: null, serviceCategory: null, itemCode: 'J3490', itemName: 'Unclassified drugs - Sertraline',
      quantity: 6, unitPricePaise: 250, taxablePaise: 1500, gstRateBp: 1200, hsnSac: '30049099', admissionId: null, encounterId: null,
      legacyChargeId: r.chargeId, medicationDispenseId: d.id, serviceDate: '2099-06-01', createdByName: 'Test Pharmacist', status: 'captured',
    })
    expect(r.lineId).toBe(lines[0].id)
  })

  it('a second bill of the same dispense creates neither', async () => {
    const { getDb, charges, eq } = await m()
    const d = await dispense()
    await bill(d)
    const before = await getDb().select().from(charges).where(eq(charges.patientId, PID))
    expect(await bill(d)).toEqual({ ok: false, error: 'This dispense has already been billed' })
    expect(await getDb().select().from(charges).where(eq(charges.patientId, PID))).toHaveLength(before.length)
    expect(await linesOf(d.id)).toHaveLength(1)
  })

  it('the line attaches to the active admission', async () => {
    const { getDb, admissions } = await m()
    const [a] = await getDb().insert(admissions).values({ patientId: PID, attendingProviderId: fx.providerId, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.admissionId = a.id
    const d = await dispense()
    await bill(d)
    expect((await linesOf(d.id))[0].admissionId).toBe(a.id)
  })

  it('service date is the IST date of the dispense (18:40Z → next day)', async () => {
    const { istDateOf } = await import('@/lib/india-time')
    const d = await dispense(2, new Date('2099-06-01T18:40:00Z'))
    const serviceDate = istDateOf(d.dispensedAt)
    expect(serviceDate).toBe('2099-06-02')
    await bill(d, serviceDate)
    expect((await linesOf(d.id))[0].serviceDate).toBe('2099-06-02')
  })

  it('a dispense over the per-line quantity limit is refused and nothing is written', async () => {
    const { getDb, charges, eq } = await m()
    const d = await dispense(1001)
    const r = await bill(d)
    expect(r).toEqual({ ok: false, error: 'This dispense is too large to bill as one line (more than 1000 units)' })
    expect(await getDb().select().from(charges).where(eq(charges.patientId, PID))).toEqual([])
  })

  it('writes its audit row on the same transaction, only when the bill is created', async () => {
    const { getDb, auditLog, eq, asc } = await m()
    const session = { userId: null, name: 'Test Pharmacist', role: 'pharmacy' as const }
    const d = await dispense()
    const { md } = await m()
    const input = {
      dispenseId: d.id, patientId: PID, providerName: 'Dr Test', dateOfService: '2099-06-01', serviceDate: '2099-06-01', createdByName: 'Test Pharmacist',
      diagnosisCode: { code: 'I10', description: 'Hypertension' },
      procedureCode: { code: 'J3490', description: 'Unclassified drugs', units: d.quantity, chargeCents: 250 },
      amountCents: d.quantity * 250,
    }
    const r = await md.createChargeForDispense(input, session)
    if (r.ok && r.chargeId) fx.charges.push(r.chargeId)
    expect(await md.createChargeForDispense(input, session)).toMatchObject({ ok: false })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.patientId, PID)).orderBy(asc(auditLog.id))
    expect(rows.map((a) => `${a.action}|${a.details}`)).toEqual([`logged a bill for a dispensed medication|charge=${r.chargeId} line=${r.lineId}`])
    await getDb().delete(auditLog).where(eq(auditLog.patientId, PID))
  })
})
