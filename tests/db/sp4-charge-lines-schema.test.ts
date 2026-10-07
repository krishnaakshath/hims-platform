import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  billingSettings, chargeRuleConfigs, chargeLines, chargeLineSourceEnum, chargeLineStatusEnum, PRICE_SOURCES,
  payers, serviceCatalog,
} from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-08-sp4-a-charge-lines.sql'
const TABLES = [billingSettings, chargeRuleConfigs, chargeLines] as const

describe('SP4 migration A (charge lines)', () => {
  it('migration A is idempotent and declares every column', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    for (const t of TABLES) expect(missingColumns(t, s)).toEqual([])
    for (const c of ['requires_preauth', 'max_quantity', 'gstin', 'state_code']) expect(s).toContain(c)
  })

  it('pins every named constraint', () => {
    const s = readMigration(MIGRATION)
    for (const n of ['billing_settings_singleton', 'charge_lines_room_rent_day_unique', 'charge_lines_service_required', 'charge_lines_context_required',
      'charge_lines_manual_reason', 'charge_lines_void_reason', 'charge_lines_unit_price_range', 'service_catalog_max_quantity_range']) expect(s).toContain(n)
  })

  it('every FK, unique, check and index name of the new tables is in the SQL and fits 63 chars', () => {
    const s = readMigration(MIGRATION)
    for (const t of [...TABLES, serviceCatalog]) {
      const c = getTableConfig(t)
      const names = [
        ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
        ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!),
      ]
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        if (t !== serviceCatalog || n === 'service_catalog_max_quantity_range') expect(s, n).toContain(n)
      }
    }
  })

  it('declares no ON DELETE action on any SP4 FK (documents are kept; deletePatient clears lines explicitly)', () => {
    const s = readMigration(MIGRATION)
    for (const t of TABLES) {
      for (const fk of getTableConfig(t).foreignKeys) {
        expect(fk.onDelete ?? 'no action', fk.getName()).toBe('no action')
        const block = s.slice(s.indexOf(`ADD CONSTRAINT ${fk.getName()}`))
        expect(block.slice(0, block.indexOf(';')), fk.getName()).not.toMatch(/ON DELETE/)
      }
    }
  })

  it('creates each enum type with every value', () => {
    const s = readMigration(MIGRATION)
    expect(chargeLineSourceEnum.enumValues).toEqual(['manual', 'room_rent', 'pharmacy'])
    expect(chargeLineStatusEnum.enumValues).toEqual(['captured', 'invoiced', 'void'])
    expect(PRICE_SOURCES).toEqual(['base', 'department', 'payer', 'manual', 'pharmacy'])
    for (const e of [chargeLineSourceEnum, chargeLineStatusEnum]) {
      expect(s, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${e.enumValues.map((v) => `'${v}'`).join(', ')});`)
    }
  })

  it('money: unit prices are int4, the computed taxable amount is bigint', () => {
    const col = (name: string) => getTableConfig(chargeLines).columns.find((c) => c.name === name)!
    expect(col('unit_price_paise').getSQLType()).toBe('integer')
    expect(col('resolved_price_paise').getSQLType()).toBe('integer')
    expect(col('taxable_paise').getSQLType()).toBe('bigint')
    expect(readMigration(MIGRATION)).toMatch(/taxable_paise bigint NOT NULL/)
  })

  it('adds the billing flags to payers and service_catalog', () => {
    const p = getTableConfig(payers).columns.map((c) => c.name)
    const sc = getTableConfig(serviceCatalog).columns.map((c) => c.name)
    expect(p).toEqual(expect.arrayContaining(['requires_preauth', 'gstin', 'state_code']))
    expect(sc).toEqual(expect.arrayContaining(['requires_preauth', 'max_quantity']))
    const s = readMigration(MIGRATION)
    expect(s).toMatch(/ALTER TABLE payers ADD COLUMN IF NOT EXISTS requires_preauth boolean NOT NULL DEFAULT false/)
    expect(s).toMatch(/ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS max_quantity integer/)
    expect(s).toContain('INSERT INTO billing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;')
  })

  it('seed clears charge lines before legacy charges and rule config, never billing settings', () => {
    const src = readFileSync(join(process.cwd(), 'src/db/seed.ts'), 'utf8')
    const body = src.slice(src.indexOf('async function clearExistingData()'), src.indexOf('export async function seed()'))
    const pos = (t: string) => body.search(new RegExp(`\\.delete\\(${t}\\)`))
    expect(pos('chargeLines')).toBeGreaterThanOrEqual(0)
    expect(pos('chargeLines')).toBeLessThan(pos('charges'))
    expect(pos('chargeLines')).toBeLessThan(pos('serviceCatalog'))
    expect(pos('chargeRuleConfigs')).toBeGreaterThanOrEqual(0)
    expect(pos('billingSettings')).toBe(-1)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('charge lines (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
  const fx = { departmentId: 0, serviceId: 0, providerId: 0, admissionId: 0, lines: [] as number[] }

  async function errorOf(p: Promise<unknown>): Promise<unknown> {
    try { await p } catch (e) { return e }
    return undefined
  }

  beforeAll(async () => {
    const { getDb } = await import('@/db/client')
    const { patients, providers, departments, admissions } = await import('@/db/schema')
    const db = getDb()
    const [prov] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    fx.providerId = prov.id
    const [dep] = await db.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [svc] = await db.insert(serviceCatalog).values({
      code: CODE, name: 'Test SP4 room', departmentId: dep.id, category: 'room_rent', hsnSac: '999311',
    }).returning()
    fx.serviceId = svc.id
    await db.insert(patients).values({ id: PID, name: 'Test SP4 Charge Lines', dob: '1990-01-01' })
    const [adm] = await db.insert(admissions).values({ patientId: PID, attendingProviderId: prov.id }).returning()
    fx.admissionId = adm.id
  })

  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { inArray } = await import('drizzle-orm')
    if (fx.lines.length) await getDb().delete(chargeLines).where(inArray(chargeLines.id, fx.lines.splice(0)))
  })

  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { patients, departments, admissions } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    await db.delete(chargeLines).where(eq(chargeLines.patientId, PID))
    await db.delete(admissions).where(eq(admissions.id, fx.admissionId))
    await db.delete(patients).where(eq(patients.id, PID))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, fx.serviceId))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
  })

  async function insertLine(v: Partial<typeof chargeLines.$inferInsert>) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(chargeLines).values({
      patientId: PID, admissionId: fx.admissionId, source: 'manual', serviceId: fx.serviceId, itemCode: CODE, itemName: 'Test SP4 room',
      serviceCategory: 'room_rent', serviceDate: '2099-01-01', quantity: 1, unitPricePaise: 150000, priceSource: 'base',
      taxablePaise: 150000, gstRateBp: 0, hsnSac: '999311', createdByName: 'TEST-SP4', ...v,
    }).returning()
    fx.lines.push(r.id)
    return r
  }

  it('has the singleton settings row with the documented defaults', async () => {
    const { getDb } = await import('@/db/client')
    const { pgConstraint } = await import('@/lib/db-errors')
    const rows = await getDb().select().from(billingSettings)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    expect(rows[0].placeOfSupplyMode).toBe('location_of_service')
    expect(rows[0].consultationWindowDays).toBe(30)
    expect(rows[0].pharmacyGstRateBp).toBe(500)
    expect(rows[0].pharmacyHsn).toBe('3004')
    expect(pgConstraint(await errorOf(getDb().insert(billingSettings).values({ id: 2 })))).toBe('billing_settings_singleton')
  })

  it('a fresh line defaults to captured with empty jsonb arrays', async () => {
    const line = await insertLine({})
    expect(line.status).toBe('captured')
    expect(line.procedureCodes).toEqual([])
    expect(line.violations).toEqual([])
    expect(line.ruleOverrides).toEqual([])
  })

  it('refuses a manual price without a reason (23514 charge_lines_manual_reason)', async () => {
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const err = await errorOf(insertLine({ priceSource: 'manual' }))
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgConstraint(err)).toBe('charge_lines_manual_reason')
    await insertLine({ priceSource: 'manual', priceOverrideReason: 'Agreed package rate' })
  })

  it('enforces the service, context, quantity, price, gst and void checks', async () => {
    const { pgConstraint } = await import('@/lib/db-errors')
    expect(pgConstraint(await errorOf(insertLine({ serviceId: null })))).toBe('charge_lines_service_required')
    expect(pgConstraint(await errorOf(insertLine({ admissionId: null })))).toBe('charge_lines_context_required')
    expect(pgConstraint(await errorOf(insertLine({ quantity: 0 })))).toBe('charge_lines_quantity_range')
    expect(pgConstraint(await errorOf(insertLine({ quantity: 1001 })))).toBe('charge_lines_quantity_range')
    expect(pgConstraint(await errorOf(insertLine({ unitPricePaise: 1_000_000_001 })))).toBe('charge_lines_unit_price_range')
    expect(pgConstraint(await errorOf(insertLine({ taxablePaise: -1 })))).toBe('charge_lines_taxable_nonneg')
    expect(pgConstraint(await errorOf(insertLine({ gstRateBp: 1000 })))).toBe('charge_lines_gst_rate_allowed')
    expect(pgConstraint(await errorOf(insertLine({ status: 'void' })))).toBe('charge_lines_void_reason')
    // A pharmacy line needs neither a service nor a context.
    const ph = await insertLine({ source: 'pharmacy', serviceId: null, admissionId: null, serviceCategory: null, priceSource: 'pharmacy', gstRateBp: 500, hsnSac: '3004' })
    expect(ph.source).toBe('pharmacy')
  })

  it('refuses a second live room-rent line for the same admission day, allows it after the first is voided', async () => {
    const { getDb } = await import('@/db/client')
    const { isUniqueViolation } = await import('@/lib/db-errors')
    const { eq } = await import('drizzle-orm')
    const first = await insertLine({ source: 'room_rent', serviceDate: '2099-02-01' })
    expect(isUniqueViolation(await errorOf(insertLine({ source: 'room_rent', serviceDate: '2099-02-01' })), 'charge_lines_room_rent_day_unique')).toBe(true)
    // Manual lines on the same day are not room rent and are unaffected.
    await insertLine({ source: 'manual', serviceDate: '2099-02-01' })
    await getDb().update(chargeLines).set({ status: 'void', voidReason: 'Posted twice', voidedAt: new Date(), voidedByName: 'TEST-SP4' })
      .where(eq(chargeLines.id, first.id))
    const again = await insertLine({ source: 'room_rent', serviceDate: '2099-02-01' })
    expect(again.status).toBe('captured')
  })

  it('stores a taxable amount above 2^31', async () => {
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    const line = await insertLine({ quantity: 3, unitPricePaise: 1_000_000_000, taxablePaise: 3_000_000_000 })
    const [back] = await getDb().select({ t: chargeLines.taxablePaise }).from(chargeLines).where(eq(chargeLines.id, line.id))
    expect(back.t).toBe(3_000_000_000)
    expect(typeof back.t).toBe('number')
  })

  it('service_catalog.max_quantity is 1..1000 or null; flags default false', async () => {
    const { getDb } = await import('@/db/client')
    const { pgConstraint } = await import('@/lib/db-errors')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const [svc] = await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, fx.serviceId))
    expect(svc.requiresPreauth).toBe(false)
    expect(svc.maxQuantity).toBeNull()
    expect(pgConstraint(await errorOf(db.update(serviceCatalog).set({ maxQuantity: 0 }).where(eq(serviceCatalog.id, fx.serviceId)))))
      .toBe('service_catalog_max_quantity_range')
    await db.update(serviceCatalog).set({ maxQuantity: 1000 }).where(eq(serviceCatalog.id, fx.serviceId))
    const [p] = await db.select({ r: payers.requiresPreauth, g: payers.gstin, s: payers.stateCode }).from(payers).limit(1)
    expect(p).toEqual({ r: false, g: null, s: null })
  })

  it('the live column types and constraint names match schema.ts', async () => {
    const { getDb } = await import('@/db/client')
    const { sql } = await import('drizzle-orm')
    const db = getDb()
    for (const t of TABLES) {
      const cfg = getTableConfig(t)
      const cols = await db.execute<{ column_name: string; data_type: string; udt_name: string; is_nullable: string }>(sql`
        SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_name = ${cfg.name}`)
      const live = new Map(cols.rows.map((r) => [r.column_name, r]))
      expect([...live.keys()].sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort())
      for (const c of cfg.columns) {
        const l = live.get(c.name)!
        const expected = c.getSQLType().replace('serial', 'integer').replace(/^timestamp$/, 'timestamp without time zone')
        expect(l.data_type === 'USER-DEFINED' ? l.udt_name : l.data_type, `${cfg.name}.${c.name}`).toBe(expected)
        expect(l.is_nullable === 'NO', `${cfg.name}.${c.name} not null`).toBe(c.notNull)
      }
      const cons = await db.execute<{ conname: string }>(sql`
        SELECT conname FROM pg_constraint WHERE conrelid = ${cfg.name}::regclass AND contype IN ('f', 'c', 'u')`)
      const expectedNames = [
        ...cfg.foreignKeys.map((f) => f.getName()), ...cfg.checks.map((k) => k.name),
        ...cfg.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!),
      ].sort()
      expect(cons.rows.map((r) => r.conname).sort(), cfg.name).toEqual(expectedNames)
      // Indexes that do not back a constraint (pkey/unique constraints are compared above).
      const idx = await db.execute<{ indexname: string }>(sql`
        SELECT i.relname AS indexname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = ${cfg.name}::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`)
      expect(idx.rows.map((r) => r.indexname).sort(), cfg.name).toEqual(cfg.indexes.map((i) => i.config.name!).sort())
    }
  })

  it('deletePatient removes a patient\'s charge lines', { timeout: 30000 }, async () => {
    const { getDb } = await import('@/db/client')
    const { patients, admissions } = await import('@/db/schema')
    const { deletePatient } = await import('@/lib/queries/patients')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const pid = `${PID}-DEL`
    await db.insert(patients).values({ id: pid, name: 'Test SP4 Delete', dob: '1990-01-01' })
    const [adm] = await db.insert(admissions).values({ patientId: pid, attendingProviderId: fx.providerId }).returning()
    await insertLine({ patientId: pid, admissionId: adm.id })
    fx.lines.splice(0)
    expect(await deletePatient(pid)).toBe(true)
    expect(await db.select().from(chargeLines).where(eq(chargeLines.patientId, pid))).toEqual([])
    expect(await db.select().from(patients).where(eq(patients.id, pid))).toEqual([])
  })
})
