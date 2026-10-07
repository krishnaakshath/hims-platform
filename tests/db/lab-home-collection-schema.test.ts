import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import {
  patients, labTests, labOrders, labResults,
  labServiceAreaPins, homeCollectionWindows, labRequisitions, homeCollectionVisits, labReports, notificationDeliveries,
  labOrderStatusEnum, homeCollectionStatusEnum, labSampleTypeEnum, labSampleContainerEnum,
  notificationChannelEnum, notificationDeliveryStatusEnum, labReportSeq,
} from '@/db/schema'
import { LAB_ORDER_STATUSES } from '@/lib/labs/status'
import { SAMPLE_TYPES, SAMPLE_CONTAINERS, LAB_QUOTE_STATUSES } from '@/lib/labs/catalog'
import { HOME_COLLECTION_STATUSES } from '@/lib/home-collection/rules'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const ENUMS = '2026-10-08-sp5-lab-enum-values.sql'
const TABLES = '2026-10-08-sp5-lab-home-collection.sql'

const NEW_TABLES = [
  ['lab_service_area_pins', labServiceAreaPins], ['home_collection_windows', homeCollectionWindows], ['lab_requisitions', labRequisitions],
  ['home_collection_visits', homeCollectionVisits], ['lab_reports', labReports], ['notification_deliveries', notificationDeliveries],
] as const

// FKs that existed before SP5 (created by older migrations / db:push); everything else on these tables is SP5's.
const PRE_SP5_CONSTRAINTS = new Set([
  'lab_orders_patient_id_patients_id_fk', 'lab_orders_lab_test_id_lab_tests_id_fk', 'lab_orders_ordered_by_provider_id_providers_id_fk',
  'lab_results_lab_order_id_lab_orders_id_fk', 'lab_results_lab_order_id_unique',
  'patients_primary_payer_id_payers_id_fk', 'patients_secondary_payer_id_payers_id_fk',
  'patients_uhid_unique', 'patients_abha_number_unique', 'patients_abha_address_unique',
])

function constraintNames(t: PgTable): string[] {
  const c = getTableConfig(t)
  return [
    ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
    ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!),
  ].filter((n) => !PRE_SP5_CONSTRAINTS.has(n))
}

const SP5_TABLES: PgTable[] = [...NEW_TABLES.map(([, t]) => t), labOrders, labTests, labResults]

describe('SP5 lab LIS & home-collection schema', () => {
  it('both migrations are idempotent and non-destructive', () => {
    expect(idempotencyProblems(readMigration(ENUMS))).toEqual([])
    expect(idempotencyProblems(readMigration(TABLES))).toEqual([])
  })

  it('the enum file only uses pre-existing neighbours', () => {
    const s = readMigration(ENUMS)
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'scheduled' BEFORE 'collected'/)
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'received' AFTER 'collected'/)
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'reported' BEFORE 'cancelled'/)
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'verified' AFTER 'resulted'/)
    expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'collector'/)
    expect(s).not.toMatch(/CREATE TABLE|ADD COLUMN|ADD CONSTRAINT|CREATE TYPE/i)
  })

  it('applying the enum file to the pre-SP5 order yields the schema order', () => {
    // Simulate Postgres BEFORE/AFTER placement over the pre-SP5 value list.
    const order = ['ordered', 'collected', 'resulted', 'cancelled']
    const s = readMigration(ENUMS).replace(/--[^\n]*/g, '')
    for (const m of s.matchAll(/ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS '(\w+)' (BEFORE|AFTER) '(\w+)'/g)) {
      const [, value, where, neighbour] = m
      const i = order.indexOf(neighbour)
      expect(i, `${neighbour} must already exist`).toBeGreaterThanOrEqual(0)
      order.splice(where === 'BEFORE' ? i : i + 1, 0, value)
    }
    expect(order).toEqual([...LAB_ORDER_STATUSES])
  })

  it('the tables file says it runs after the enum file', () => {
    expect(readMigration(TABLES)).toContain(ENUMS)
  })

  it.each(NEW_TABLES)('tables migration declares every %s column', (_n, t) => {
    expect(missingColumns(t, readMigration(TABLES))).toEqual([])
  })

  it('declares every SP5 column on existing tables', () => {
    const s = readMigration(TABLES)
    for (const c of ['notification_opt_out', 'notification_opt_out_at', 'sample_type', 'container', 'service_id', 'resulted_by_user_id',
      'amended_at', 'requisition_id', 'home_collection_visit_id', 'sample_id', 'sample_date', 'sample_seq', 'collected_by_name',
      'received_at', 'received_by_name', 'verified_at', 'verified_by_name', 'verified_by_user_id', 'reported_at', 'cancelled_at',
      'cancelled_by_name', 'cancel_reason', 'quoted_price_paise', 'quoted_tariff_rate_id', 'quoted_on', 'quote_status', 'status_changed_at']) {
      expect(s).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`))
    }
  })

  it('every SP5 FK, unique, check and index name is in the SQL and fits 63 chars', () => {
    const s = readMigration(TABLES)
    for (const t of SP5_TABLES) {
      const names = constraintNames(t)
      expect(names.length, getTableConfig(t).name).toBeGreaterThan(0)
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        expect(s, n).toContain(n)
      }
    }
  })

  it('declares the ON DELETE behaviour of each SP5 FK in the migration', () => {
    const s = readMigration(TABLES)
    for (const t of SP5_TABLES) {
      for (const fk of getTableConfig(t).foreignKeys) {
        const name = fk.getName()
        if (PRE_SP5_CONSTRAINTS.has(name)) continue
        const block = s.slice(s.indexOf(`ADD CONSTRAINT ${name}`))
        const stmt = block.slice(0, block.indexOf(';'))
        const expected = fk.onDelete === 'set null' ? /ON DELETE SET NULL/ : fk.onDelete === 'cascade' ? /ON DELETE CASCADE/ : /^(?![\s\S]*ON DELETE)/
        expect(stmt, name).toMatch(expected)
      }
    }
  })

  it('enum values match the pure constants, in order', () => {
    expect(labOrderStatusEnum.enumValues).toEqual([...LAB_ORDER_STATUSES])
    expect(homeCollectionStatusEnum.enumValues).toEqual([...HOME_COLLECTION_STATUSES])
    expect(labSampleTypeEnum.enumValues).toEqual([...SAMPLE_TYPES])
    expect(labSampleContainerEnum.enumValues).toEqual([...SAMPLE_CONTAINERS])
    expect(notificationChannelEnum.enumValues).toEqual(['log', 'sms', 'whatsapp', 'email'])
    expect(notificationDeliveryStatusEnum.enumValues).toEqual(['logged', 'sent', 'failed', 'suppressed_opt_out', 'skipped_no_contact'])
    expect(getTableConfig(labOrders).columns.find((c) => c.name === 'quote_status')!.enumValues).toEqual([...LAB_QUOTE_STATUSES])
  })

  it('the tables migration creates each new enum type with every value, and the report sequence', () => {
    const s = readMigration(TABLES)
    for (const e of [labSampleTypeEnum, labSampleContainerEnum, homeCollectionStatusEnum, notificationChannelEnum, notificationDeliveryStatusEnum]) {
      const values = e.enumValues.map((v) => `'${v}'`).join(', ')
      expect(s, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${values});`)
    }
    expect(labReportSeq.seqName).toBe('lab_report_seq')
    expect(s).toContain('CREATE SEQUENCE IF NOT EXISTS lab_report_seq')
  })

  it('clearExistingData() and deletePatient() clear SP5 tables children-first, before patients', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const seed = readFileSync(join(process.cwd(), 'src/db/seed.ts'), 'utf8')
    const body = seed.slice(seed.indexOf('async function clearExistingData()'), seed.indexOf('export async function seed()'))
    const seedOrder = ['notificationDeliveries', 'labReports', 'labResults', 'labOrders', 'homeCollectionVisits', 'labRequisitions',
      'homeCollectionWindows', 'labServiceAreaPins', 'patients'].map((t) => body.indexOf(`await db.delete(${t})`))
    expect(seedOrder.every((i) => i >= 0)).toBe(true)
    expect([...seedOrder].sort((a, b) => a - b)).toEqual(seedOrder)
    expect(body.indexOf('await db.update(labTests).set({ serviceId: null })')).toBeLessThan(body.indexOf('await db.delete(serviceCatalog)'))

    const src = readFileSync(join(process.cwd(), 'src/lib/queries/patients.ts'), 'utf8')
    const del = src.slice(src.indexOf('export async function deletePatient'))
    const order = ['notificationDeliveries', 'labReports', 'labResults', 'labOrders', 'homeCollectionVisits', 'labRequisitions', 'patients']
      .map((t) => del.indexOf(`await db.delete(${t})`))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('backfills one requisition per legacy order, idempotently', () => {
    const s = readMigration(TABLES)
    expect(s).toMatch(/INSERT INTO lab_requisitions[\s\S]*legacy_lab_order_id[\s\S]*ON CONFLICT \(legacy_lab_order_id\) DO NOTHING;/)
    expect(s).toMatch(/UPDATE lab_orders o SET requisition_id = r\.id FROM lab_requisitions r WHERE r\.legacy_lab_order_id = o\.id AND o\.requisition_id IS NULL;/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('SP5 schema (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP5-${RUN}`
  let providerId = 0
  let labTestId = 0
  let windowId = 0

  async function errorOf(p: Promise<unknown>): Promise<unknown> {
    try { await p } catch (e) { return e }
    return undefined
  }

  async function cleanup() {
    const { getDb } = await import('@/db/client')
    const { eq, inArray } = await import('drizzle-orm')
    const db = getDb()
    const orderIds = (await db.select({ id: labOrders.id }).from(labOrders).where(eq(labOrders.patientId, PID))).map((o) => o.id)
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.patientId, PID))
    await db.delete(labReports).where(eq(labReports.patientId, PID))
    if (orderIds.length) await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
    await db.delete(labOrders).where(eq(labOrders.patientId, PID))
    await db.delete(homeCollectionVisits).where(eq(homeCollectionVisits.patientId, PID))
    await db.delete(labRequisitions).where(eq(labRequisitions.patientId, PID))
    await db.delete(patients).where(eq(patients.id, PID))
  }

  beforeAll(async () => {
    const { getDb } = await import('@/db/client')
    const { providers } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).orderBy(providers.id).limit(1)
    providerId = p.id
    const [lt] = await db.select({ id: labTests.id }).from(labTests).orderBy(labTests.id).limit(1)
    labTestId = lt.id
    const [w] = await db.insert(homeCollectionWindows).values({
      label: `TEST-SP5-${RUN}`, startTime: '07:00', endTime: '09:00', capacity: 5,
    }).returning({ id: homeCollectionWindows.id })
    windowId = w.id
  })

  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    await cleanup()
    if (windowId) await getDb().delete(homeCollectionWindows).where(eq(homeCollectionWindows.id, windowId))
  })

  async function freshPatient() {
    const { getDb } = await import('@/db/client')
    await cleanup()
    await getDb().insert(patients).values({ id: PID, name: 'Test SP5 Schema', dob: '1990-01-01' })
  }

  async function insertVisit(v: Partial<typeof homeCollectionVisits.$inferInsert> = {}) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(homeCollectionVisits).values({
      patientId: PID, visitDate: '2099-03-01', windowId, windowLabel: 'Early', windowStart: '07:00', windowEnd: '09:00',
      addressLine1: 'TEST-SP5', city: 'Test', stateCode: 'IN-KA', pinCode: '990001', contactPhone: '+919999999999', bookedByName: 'TEST-SP5', ...v,
    }).returning()
    return r
  }

  async function insertOrder(v: Partial<typeof labOrders.$inferInsert> = {}) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(labOrders).values({ patientId: PID, labTestId, orderedByProviderId: providerId, ...v }).returning()
    return r
  }

  it('the live lab_order_status enum has the schema order', async () => {
    const { getDb } = await import('@/db/client')
    const r = await getDb().execute<{ v: string }>(sql`select enum_range(null::lab_order_status)::text as v`)
    expect(r.rows[0].v).toBe(`{${LAB_ORDER_STATUSES.join(',')}}`)
  })

  it('every schema.ts column of the SP5 tables exists in the live DB', async () => {
    const { getDb } = await import('@/db/client')
    for (const t of [...SP5_TABLES, patients]) {
      const name = getTableConfig(t).name
      const r = await getDb().execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${name}`)
      const live = new Set(r.rows.map((x) => x.column_name))
      const missing = getTableConfig(t).columns.map((c) => c.name).filter((c) => !live.has(c))
      expect(missing, name).toEqual([])
    }
  })

  it('every SP5 constraint and index name exists in the live DB', async () => {
    const { getDb } = await import('@/db/client')
    const r = await getDb().execute<{ n: string }>(sql`select conname as n from pg_constraint union select indexname as n from pg_indexes where schemaname = 'public'`)
    const live = new Set(r.rows.map((x) => x.n))
    for (const t of SP5_TABLES) for (const n of constraintNames(t)) expect(live.has(n), n).toBe(true)
  })

  it('a patient cannot hold two booked visits in one slot, but can rebook after cancelling', async () => {
    const { getDb } = await import('@/db/client')
    const { isUniqueViolation } = await import('@/lib/db-errors')
    const { eq } = await import('drizzle-orm')
    await freshPatient()
    const first = await insertVisit()
    expect(first.status).toBe('booked')
    expect(isUniqueViolation(await errorOf(insertVisit()), 'home_collection_visits_patient_slot_unique')).toBe(true)
    await getDb().update(homeCollectionVisits).set({ status: 'cancelled', cancelReason: 'patient_request', cancelledAt: new Date() })
      .where(eq(homeCollectionVisits.id, first.id))
    const second = await insertVisit()
    expect(second.id).not.toBe(first.id)
  })

  it('a cancelled visit needs a reason and a collected visit needs collected_at', async () => {
    const { pgConstraint } = await import('@/lib/db-errors')
    await freshPatient()
    expect(pgConstraint(await errorOf(insertVisit({ status: 'cancelled' })))).toBe('home_collection_visits_cancel_reason')
    expect(pgConstraint(await errorOf(insertVisit({ status: 'collected' })))).toBe('home_collection_visits_collected_at')
    expect(pgConstraint(await errorOf(insertVisit({ pinCode: '012345' })))).toBe('home_collection_visits_pin_format')
  })

  it('a scheduled order must point at a visit', async () => {
    const { getDb } = await import('@/db/client')
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const { eq } = await import('drizzle-orm')
    await freshPatient()
    const o = await insertOrder()
    const err = await errorOf(getDb().update(labOrders).set({ status: 'scheduled' }).where(eq(labOrders.id, o.id)))
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgConstraint(err)).toBe('lab_orders_scheduled_has_visit')
    const visit = await insertVisit()
    await getDb().update(labOrders).set({ status: 'scheduled', homeCollectionVisitId: visit.id }).where(eq(labOrders.id, o.id))
    // Deleting the visit nulls the link, which the check then refuses for a scheduled order.
    await getDb().update(labOrders).set({ status: 'ordered' }).where(eq(labOrders.id, o.id))
    await getDb().delete(homeCollectionVisits).where(eq(homeCollectionVisits.id, visit.id))
    const [after] = await getDb().select().from(labOrders).where(eq(labOrders.id, o.id))
    expect(after.homeCollectionVisitId).toBeNull()
    expect(after.quoteStatus).toBe('unmapped')
  })

  it('rejects a quoted price over 1e9 paise and an unpaired sample id', async () => {
    const { pgConstraint } = await import('@/lib/db-errors')
    await freshPatient()
    expect(pgConstraint(await errorOf(insertOrder({ quotedPricePaise: 1_000_000_001 })))).toBe('lab_orders_quoted_price_range')
    expect(pgConstraint(await errorOf(insertOrder({ quotedPricePaise: -1 })))).toBe('lab_orders_quoted_price_range')
    await insertOrder({ quotedPricePaise: 1_000_000_000 })
    expect(pgConstraint(await errorOf(insertOrder({ sampleId: 'L9903010001X', sampleDate: '2099-03-01' })))).toBe('lab_orders_sample_pair')
  })

  it('rejects a duplicate (sample_date, sample_seq)', async () => {
    const { isUniqueViolation } = await import('@/lib/db-errors')
    await freshPatient()
    await insertOrder({ sampleId: `TEST-SP5-${RUN}-A`, sampleDate: '2099-03-02', sampleSeq: 9001 })
    const err = await errorOf(insertOrder({ sampleId: `TEST-SP5-${RUN}-B`, sampleDate: '2099-03-02', sampleSeq: 9001 }))
    expect(isUniqueViolation(err, 'lab_orders_sample_date_seq_unique')).toBe(true)
  })

  it('requisition follow-up fields must be all-or-nothing', async () => {
    const { getDb } = await import('@/db/client')
    const { pgConstraint } = await import('@/lib/db-errors')
    await freshPatient()
    const base = { patientId: PID, orderedByProviderId: providerId, createdByName: 'TEST-SP5' }
    expect(pgConstraint(await errorOf(getDb().insert(labRequisitions).values({ ...base, followUpIntervalValue: 2 }))))
      .toBe('lab_requisitions_follow_up_fields')
    expect(pgConstraint(await errorOf(getDb().insert(labRequisitions).values({ ...base, followUpRequested: true, followUpIntervalValue: 0, followUpIntervalUnit: 'weeks' }))))
      .toBe('lab_requisitions_follow_up_fields')
    await getDb().insert(labRequisitions).values({ ...base, followUpRequested: true, followUpIntervalValue: 2, followUpIntervalUnit: 'weeks' })
  })

  it('window, PIN and report checks hold', async () => {
    const { getDb } = await import('@/db/client')
    const { pgConstraint } = await import('@/lib/db-errors')
    const db = getDb()
    expect(pgConstraint(await errorOf(db.insert(homeCollectionWindows).values({ label: 'x', startTime: '7:00', endTime: '09:00', capacity: 1 }))))
      .toBe('home_collection_windows_time_format')
    expect(pgConstraint(await errorOf(db.insert(homeCollectionWindows).values({ label: 'x', startTime: '09:00', endTime: '08:00', capacity: 1 }))))
      .toBe('home_collection_windows_time_order')
    expect(pgConstraint(await errorOf(db.insert(homeCollectionWindows).values({ label: 'x', startTime: '08:00', endTime: '09:00', capacity: 51 }))))
      .toBe('home_collection_windows_capacity_range')
    expect(pgConstraint(await errorOf(db.insert(labServiceAreaPins).values({ pinCode: '99001', createdByName: 'TEST-SP5' }))))
      .toBe('lab_service_area_pins_pin_format')
    await freshPatient()
    const [req] = await db.insert(labRequisitions).values({ patientId: PID, orderedByProviderId: providerId, createdByName: 'TEST-SP5' }).returning()
    expect(pgConstraint(await errorOf(db.insert(labReports).values({
      reportNumber: `TEST-SP5-${RUN}`, requisitionId: req.id, patientId: PID, version: 0, orderIds: [], testSummary: 'x',
      blobUrl: 'x', byteSize: 1, sha256: 'x', releasedByName: 'TEST-SP5',
    })))).toBe('lab_reports_version_positive')
  })

  it('deletePatient removes the patient\'s requisitions, visits, orders, reports and deliveries', { timeout: 30000 }, async () => {
    const { getDb } = await import('@/db/client')
    const { deletePatient } = await import('@/lib/queries/patients')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    await freshPatient()
    const [req] = await db.insert(labRequisitions).values({ patientId: PID, orderedByProviderId: providerId, createdByName: 'TEST-SP5' }).returning()
    const visit = await insertVisit()
    const order = await insertOrder({ requisitionId: req.id, homeCollectionVisitId: visit.id, status: 'scheduled' })
    await db.insert(labReports).values({
      reportNumber: `TEST-SP5-${RUN}-R`, requisitionId: req.id, patientId: PID, version: 1, orderIds: [order.id], testSummary: 'x',
      blobUrl: 'x', byteSize: 1, sha256: 'x', releasedByName: 'TEST-SP5',
    })
    await db.insert(notificationDeliveries).values({
      patientId: PID, templateKey: 'test', channel: 'log', status: 'logged', relatedType: 'lab_requisition', relatedId: req.id, createdByName: 'TEST-SP5',
    })

    expect(await deletePatient(PID)).toBe(true)
    expect(await db.select().from(patients).where(eq(patients.id, PID))).toEqual([])
    expect(await db.select().from(labRequisitions).where(eq(labRequisitions.patientId, PID))).toEqual([])
    expect(await db.select().from(homeCollectionVisits).where(eq(homeCollectionVisits.patientId, PID))).toEqual([])
    expect(await db.select().from(labReports).where(eq(labReports.patientId, PID))).toEqual([])
    expect(await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.patientId, PID))).toEqual([])
  })
})
