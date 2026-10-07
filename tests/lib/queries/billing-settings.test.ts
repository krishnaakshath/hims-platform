import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Session } from '@/lib/auth'

describe.skipIf(!process.env.DATABASE_URL)('billing settings queries (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
  const ACTOR = `TEST-SP4-${RUN}`
  const session: Session = { role: 'admin', name: ACTOR, userId: null }
  const fx = { departmentId: 0, roomServiceId: 0, consultServiceId: 0, payerId: 0 }
  let savedSettings: Record<string, unknown> | null = null
  let savedPayer: { requiresPreauth: boolean; gstin: string | null; stateCode: string | null } | null = null
  const savedRules = new Map<string, unknown>()

  const mods = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    q: await import('@/lib/queries/billing-settings'),
  })

  beforeAll(async () => {
    const { getDb, departments, serviceCatalog, payers, billingSettings, chargeRuleConfigs, eq } = await mods()
    const db = getDb()
    const [dep] = await db.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [room] = await db.insert(serviceCatalog).values({ code: `${CODE}R`, name: 'Test room', departmentId: dep.id, category: 'room_rent', hsnSac: '999311' }).returning()
    const [cons] = await db.insert(serviceCatalog).values({ code: `${CODE}C`, name: 'Test consult', departmentId: dep.id, category: 'consultation', hsnSac: '999312' }).returning()
    fx.roomServiceId = room.id
    fx.consultServiceId = cons.id
    const [payer] = await db.select().from(payers).orderBy(payers.id).limit(1)
    fx.payerId = payer.id
    savedPayer = { requiresPreauth: payer.requiresPreauth, gstin: payer.gstin, stateCode: payer.stateCode }
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    for (const r of await db.select().from(chargeRuleConfigs)) savedRules.set(r.ruleCode, r)
  })

  afterAll(async () => {
    const { getDb, departments, serviceCatalog, payers, billingSettings, chargeRuleConfigs, auditLog, eq, inArray, notInArray } = await mods()
    const db = getDb()
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    const keep = [...savedRules.keys()]
    if (keep.length) await db.delete(chargeRuleConfigs).where(notInArray(chargeRuleConfigs.ruleCode, keep))
    else await db.delete(chargeRuleConfigs)
    for (const r of savedRules.values()) {
      const row = r as typeof chargeRuleConfigs.$inferSelect
      await db.update(chargeRuleConfigs).set(row).where(eq(chargeRuleConfigs.ruleCode, row.ruleCode))
    }
    if (savedPayer) await db.update(payers).set(savedPayer).where(eq(payers.id, fx.payerId))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [fx.roomServiceId, fx.consultServiceId]))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
    await db.delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  const INPUT = {
    legalName: 'Test SP4 Hospital', gstin: '29AAGCB7383J1Z4', stateCode: 'IN-KA', address: 'MG Road', placeOfSupplyMode: 'location_of_service' as const,
    consultationWindowDays: 15, ipdDepositThresholdPaise: 500000, roomRentServiceId: null as number | null, pharmacyGstRateBp: 500, pharmacyHsn: '3004',
  }

  async function auditRows() {
    const { getDb, auditLog, eq, asc } = await mods()
    return getDb().select().from(auditLog).where(eq(auditLog.userName, ACTOR)).orderBy(asc(auditLog.id))
  }

  it('round-trips settings and writes one audit row in the same transaction', async () => {
    const { q } = await mods()
    const before = (await auditRows()).length
    expect(await q.updateBillingSettings({ ...INPUT, roomRentServiceId: fx.roomServiceId }, session)).toEqual({ ok: true })
    const s = await q.getBillingSettings()
    expect(s).toMatchObject({ ...INPUT, roomRentServiceId: fx.roomServiceId, updatedByName: ACTOR })
    const rows = await auditRows()
    expect(rows).toHaveLength(before + 1)
    const last = rows[rows.length - 1]
    expect(last.action).toBe('billing: updated billing settings')
    expect(last.patientId).toBeNull()
    expect(last.details).toMatch(/^fields=[a-zA-Z,]+$/)
    expect(last.details!.split('=')[1].split(',')).toEqual([...last.details!.split('=')[1].split(',')].sort())

    // Saving the same values again changes nothing: an empty field list.
    await q.updateBillingSettings({ ...INPUT, roomRentServiceId: fx.roomServiceId }, session)
    const again = await auditRows()
    expect(again[again.length - 1].details).toBe('fields=')
  })

  it('refuses a room-rent service outside the Room rent category, writing nothing', async () => {
    const { q } = await mods()
    await q.updateBillingSettings(INPUT, session)
    const before = (await auditRows()).length
    expect(await q.updateBillingSettings({ ...INPUT, legalName: 'Changed', roomRentServiceId: fx.consultServiceId }, session))
      .toEqual({ ok: false, error: 'room_rent_service_invalid' })
    expect(await q.updateBillingSettings({ ...INPUT, roomRentServiceId: 2_147_483_000 }, session))
      .toEqual({ ok: false, error: 'room_rent_service_invalid' })
    expect((await q.getBillingSettings()).legalName).toBe(INPUT.legalName)
    expect((await auditRows()).length).toBe(before)
  })

  it('rule config upsert is reflected by getRuleConfig and listRuleRows', async () => {
    const { q } = await mods()
    expect(await q.setRuleConfig('duplicate_charge', { enabled: true, severity: 'warn' }, session)).toEqual({ ok: true })
    expect(await q.setRuleConfig('quantity_limit', { enabled: false, severity: null }, session)).toEqual({ ok: true })
    const cfg = await q.getRuleConfig()
    expect(cfg.duplicate_charge).toEqual({ enabled: true, severity: 'warn' })
    expect(cfg.quantity_limit).toEqual({ enabled: false, severity: null })
    const rows = await q.listRuleRows()
    expect(rows.map((r) => r.code)).toEqual((await import('@/lib/billing/charge-rules')).CHARGE_RULE_CODES)
    expect(rows.find((r) => r.code === 'duplicate_charge')).toMatchObject({ enabled: true, severity: 'warn', effectiveSeverity: 'warn' })
    expect(rows.find((r) => r.code === 'quantity_limit')).toMatchObject({ enabled: false, severity: null, effectiveSeverity: 'block' })
    // A second write to the same rule updates in place.
    await q.setRuleConfig('duplicate_charge', { enabled: true, severity: null }, session)
    expect((await q.getRuleConfig()).duplicate_charge).toEqual({ enabled: true, severity: null })
    const audit = await auditRows()
    expect(audit[audit.length - 1]).toMatchObject({ action: 'billing: updated charge rule', details: 'rule=duplicate_charge enabled=true severity=default' })
  })

  it('a non-configurable rule is refused', async () => {
    const { q } = await mods()
    expect(await q.setRuleConfig('price_unresolved', { enabled: false, severity: null }, session)).toEqual({ ok: false, error: 'not_configurable' })
    expect((await q.getRuleConfig()).price_unresolved).toBeUndefined()
  })

  it('updates payer billing flags and audits the payer id only', async () => {
    const { q, getDb, payers, eq } = await mods()
    expect(await q.updatePayerBillingFlags(fx.payerId, { requiresPreauth: true, gstin: '27AAPFU0939F1ZV', stateCode: 'IN-MH' }, session)).toBe(true)
    const [p] = await getDb().select().from(payers).where(eq(payers.id, fx.payerId))
    expect(p).toMatchObject({ requiresPreauth: true, gstin: '27AAPFU0939F1ZV', stateCode: 'IN-MH' })
    const audit = await auditRows()
    expect(audit[audit.length - 1]).toMatchObject({ action: 'billing: updated payer billing flags', details: `payer=${fx.payerId}` })
    expect(await q.updatePayerBillingFlags(2_147_483_000, { requiresPreauth: false, gstin: null, stateCode: null }, session)).toBe(false)
  })
})
