import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'

// SP4 Task 13 → WS2 T8: billing a legacy dispense writes ONE pharmacy charge line at the current
// MRP (no legacy `charges` row, no diagnosis, no HCPCS code), atomically with its audit row.
describe.skipIf(!process.env.DATABASE_URL)('pharmacy legacy dispense charge line (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const fx = { medId: 0, dispenses: [] as number[], admissionId: 0, providerId: 0 }
  const session = { userId: null, name: 'Test Pharmacist', role: 'pharmacy' as const }
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
    // No own GST rate or HSN: the billing settings defaults apply.
    const [med] = await db.insert(medications).values({ name: `Test SP4 Med ${RUN}`, medicationClass: 'Test', form: 'tablet', mrpPerUnitPaise: 280 }).returning()
    fx.medId = med.id
    await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 100, reorderThreshold: 5, unit: 'tablets' })
    await db.insert(patients).values({ id: PID, name: 'Test SP4 Pharmacy', dob: '1990-01-01' })
  })

  afterEach(async () => {
    const { getDb, medicationDispenses, admissions, auditLog, inArray, eq } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures([PID])
    if (fx.dispenses.length) await db.delete(medicationDispenses).where(inArray(medicationDispenses.id, fx.dispenses.splice(0)))
    if (fx.admissionId) { await db.delete(admissions).where(eq(admissions.id, fx.admissionId)); fx.admissionId = 0 }
    await db.delete(auditLog).where(eq(auditLog.patientId, PID))
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

  async function linesOf(dispenseId: number) {
    const { getDb, chargeLines, eq } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, dispenseId))
  }

  it('creates one pharmacy charge line at the current MRP with the settings GST/HSN, and no legacy charge', async () => {
    const { md, getDb, charges, eq } = await m()
    const d = await dispense()
    const r = await md.billLegacyDispense(d.id, session)
    expect(r).toMatchObject({ ok: true })
    const lines = await linesOf(d.id)
    expect(lines).toHaveLength(1)
    // ₹2.80 × 6 at 12%: unit 250 → taxable 1500, GST 180, total 1680 = MRP × 6.
    expect(lines[0]).toMatchObject({
      patientId: PID, source: 'pharmacy', priceSource: 'pharmacy', serviceId: null, serviceCategory: null, itemCode: `MED-${fx.medId}`, itemName: `Test SP4 Med ${RUN}`,
      quantity: 6, unitPricePaise: 250, taxablePaise: 1500, gstRateBp: 1200, hsnSac: '30049099', admissionId: null, encounterId: null,
      legacyChargeId: null, medicationDispenseId: d.id, serviceDate: '2099-06-01', createdByName: 'Test Pharmacist', status: 'captured',
    })
    expect(r.ok && r.lineId).toBe(lines[0].id)
    expect(await getDb().select().from(charges).where(eq(charges.patientId, PID))).toEqual([])
  })

  it('a second bill of the same dispense creates nothing', async () => {
    const { md } = await m()
    const d = await dispense()
    await md.billLegacyDispense(d.id, session)
    expect(await md.billLegacyDispense(d.id, session)).toEqual({ ok: false, error: 'already_billed' })
    expect(await linesOf(d.id)).toHaveLength(1)
  })

  it('the line attaches to the active admission', async () => {
    const { getDb, admissions, md } = await m()
    const [a] = await getDb().insert(admissions).values({ patientId: PID, attendingProviderId: fx.providerId, admittedAt: new Date('2099-05-30T06:00:00Z') }).returning()
    fx.admissionId = a.id
    const d = await dispense()
    await md.billLegacyDispense(d.id, session)
    expect((await linesOf(d.id))[0].admissionId).toBe(a.id)
  })

  it('service date is the IST date of the dispense (18:40Z → next day)', async () => {
    const { md } = await m()
    const d = await dispense(2, new Date('2099-06-01T18:40:00Z'))
    await md.billLegacyDispense(d.id, session)
    expect((await linesOf(d.id))[0].serviceDate).toBe('2099-06-02')
  })

  it('a dispense over the per-line quantity limit is refused and nothing is written', async () => {
    const { md } = await m()
    const d = await dispense(1001)
    expect(await md.billLegacyDispense(d.id, session)).toEqual({ ok: false, error: 'quantity_too_large' })
    expect(await linesOf(d.id)).toEqual([])
  })

  it('writes its audit row on the same transaction, only when the bill is created', async () => {
    const { getDb, auditLog, eq, asc, md } = await m()
    const d = await dispense()
    const r = await md.billLegacyDispense(d.id, session)
    expect(await md.billLegacyDispense(d.id, session)).toMatchObject({ ok: false })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.patientId, PID)).orderBy(asc(auditLog.id))
    expect(rows.map((a) => `${a.action}|${a.details}`)).toEqual([`billed a legacy dispense|dispense=${d.id} line=${r.ok ? r.lineId : 0}`])
  })
})
