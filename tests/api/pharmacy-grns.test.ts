import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { GET as listGrnsRoute, POST as postGrnRoute } from '@/app/api/pharmacy/grns/route'
import { getDb } from '@/db/client'
import { medications, medicationInventory, medicationBatches, pharmacyGrns, auditLog } from '@/db/schema'
import { todayIsoIn } from '@/lib/india-time'
import { readMigration, idempotencyProblems, missingColumns } from '../db/migration-sql'

let sessionRole: 'admin' | 'pharmacy' | 'frontdesk' | 'billing' = 'pharmacy'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'WS5 T3 Pharmacist' })) }))

const MIGRATION = '2026-10-25-ws5-pharmacy-grns.sql'
const FUTURE = '2099-12-31'

const medIds: number[] = []
afterEach(async () => {
  sessionRole = 'pharmacy'
  const db = getDb()
  if (medIds.length === 0) return
  const batches = await db.select({ grnId: medicationBatches.grnId }).from(medicationBatches).where(inArray(medicationBatches.medicationId, medIds))
  const grnIds = [...new Set(batches.map((b) => b.grnId).filter((g): g is number => g !== null))]
  await db.delete(medicationBatches).where(inArray(medicationBatches.medicationId, medIds))
  if (grnIds.length > 0) await db.delete(pharmacyGrns).where(inArray(pharmacyGrns.id, grnIds))
  await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, medIds))
  await db.delete(medications).where(inArray(medications.id, medIds))
  medIds.length = 0
})

async function seedMed(opening: number): Promise<number> {
  const db = getDb()
  const [m] = await db.insert(medications).values({ name: `WS5 T3 grn ${Date.now()}-${Math.random()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  medIds.push(m.id)
  await db.insert(medicationInventory).values({ medicationId: m.id, quantityOnHand: opening })
  if (opening > 0) await db.insert(medicationBatches).values({ medicationId: m.id, batchNo: 'OPENING', mrpPerUnitPaise: 0, quantityOnHand: opening })
  return m.id
}

type Line = { medicationId: number; batchNo: string; expiryDate: string; quantity: number; mrpPerUnitPaise: number; purchaseRatePaise: number }
function body(lines: Line[], overrides: Record<string, unknown> = {}) {
  return {
    supplierName: 'Sri Venkateswara Pharma Distributors',
    supplierInvoiceNo: `INV-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    supplierInvoiceDate: todayIsoIn(),
    lines,
    ...overrides,
  }
}
const post = (b: unknown) => postGrnRoute(new NextRequest('http://localhost/api/pharmacy/grns', { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }))
const list = () => listGrnsRoute(new NextRequest('http://localhost/api/pharmacy/grns?limit=50'))

async function onHand(medicationId: number): Promise<number> {
  const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, medicationId))
  return inv.quantityOnHand
}
async function grnCountFor(supplierInvoiceNo: string): Promise<number> {
  return (await getDb().select().from(pharmacyGrns).where(eq(pharmacyGrns.supplierInvoiceNo, supplierInvoiceNo))).length
}

describe('WS5 T3 migration (pharmacy GRNs)', () => {
  it('is idempotent, declares every column and constraint, adds the grn series and the batch FK', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(missingColumns(pharmacyGrns, s)).toEqual([])
    expect(s).toMatch(/ALTER TYPE document_series ADD VALUE IF NOT EXISTS 'grn';/)
    const c = getTableConfig(pharmacyGrns)
    const names = [
      ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
      ...c.uniqueConstraints.map((u) => u.getName()!),
      ...getTableConfig(medicationBatches).foreignKeys.map((f) => f.getName()).filter((n) => n.includes('grn')),
    ]
    expect(names).toContain('medication_batches_grn_id_pharmacy_grns_id_fk')
    for (const n of names) {
      expect(n.length, n).toBeLessThanOrEqual(63)
      expect(s, n).toContain(n)
    }
  })
})

describe('POST /api/pharmacy/grns', () => {
  it('a valid GRN adds batches, raises on-hand totals, stores the total and audits ids and counts', async () => {
    const a = await seedMed(5)
    const b = await seedMed(0)
    const payload = body([
      { medicationId: a, batchNo: 'PCM-2601', expiryDate: FUTURE, quantity: 100, mrpPerUnitPaise: 250, purchaseRatePaise: 180 },
      { medicationId: a, batchNo: 'PCM-2602', expiryDate: '2099-06-30', quantity: 20, mrpPerUnitPaise: 260, purchaseRatePaise: 190 },
      { medicationId: b, batchNo: 'AMX/77', expiryDate: FUTURE, quantity: 30, mrpPerUnitPaise: 1200, purchaseRatePaise: 905 },
    ])
    const res = await post(payload)
    expect(res.status).toBe(201)
    const out = await res.json()
    expect(typeof out.grnId).toBe('number')
    expect(out.grnNumber).toMatch(/^GRN\/\d{2}-\d{2}\/\d{6}$/)

    expect(await onHand(a)).toBe(125)
    expect(await onHand(b)).toBe(30)
    const batches = await getDb().select().from(medicationBatches).where(inArray(medicationBatches.medicationId, [a, b]))
    const received = batches.filter((x) => x.batchNo !== 'OPENING')
    expect(received.map((x) => [x.batchNo, x.expiryDate, x.quantityOnHand, x.mrpPerUnitPaise, x.purchaseRatePaise, x.grnId]).sort()).toEqual([
      ['AMX/77', FUTURE, 30, 1200, 905, out.grnId],
      ['PCM-2601', FUTURE, 100, 250, 180, out.grnId],
      ['PCM-2602', '2099-06-30', 20, 260, 190, out.grnId],
    ])

    const [grn] = await getDb().select().from(pharmacyGrns).where(eq(pharmacyGrns.id, out.grnId))
    expect(grn.totalPaise).toBe(100 * 180 + 20 * 190 + 30 * 905)
    expect(grn.grnNumber).toBe(out.grnNumber)
    expect(grn.receivedByName).toBe('WS5 T3 Pharmacist')
    expect(grn.lineCount).toBe(3)

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.details, `grn=${out.grnId} lines=3`))
    expect(audits.map((x) => x.action)).toEqual(['pharmacy: received GRN'])
  })

  it('adds quantity to an existing batch when expiry and MRP match', async () => {
    const a = await seedMed(0)
    const first = await post(body([{ medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 10, mrpPerUnitPaise: 500, purchaseRatePaise: 400 }]))
    expect(first.status).toBe(201)
    sessionRole = 'admin'
    const second = await post(body([{ medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 15, mrpPerUnitPaise: 500, purchaseRatePaise: 410 }]))
    expect(second.status).toBe(201)
    const rows = await getDb().select().from(medicationBatches).where(eq(medicationBatches.medicationId, a))
    expect(rows.map((r) => [r.batchNo, r.quantityOnHand])).toEqual([['B1', 25]])
    expect(await onHand(a)).toBe(25)
  })

  it('refuses an expiry on or before today (IST) with 422 and writes nothing', async () => {
    const a = await seedMed(5)
    const payload = body([
      { medicationId: a, batchNo: 'OK-1', expiryDate: FUTURE, quantity: 10, mrpPerUnitPaise: 100, purchaseRatePaise: 80 },
      { medicationId: a, batchNo: 'OLD-1', expiryDate: todayIsoIn(), quantity: 10, mrpPerUnitPaise: 100, purchaseRatePaise: 80 },
    ])
    const res = await post(payload)
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('expired_on_receipt')
    expect(await grnCountFor(payload.supplierInvoiceNo)).toBe(0)
    const rows = await getDb().select().from(medicationBatches).where(eq(medicationBatches.medicationId, a))
    expect(rows.map((r) => r.batchNo)).toEqual(['OPENING'])
    expect(await onHand(a)).toBe(5)
  })

  it('refuses the same batch number with a different expiry with 409 and rolls the whole GRN back', async () => {
    const a = await seedMed(0)
    const b = await seedMed(0)
    expect((await post(body([{ medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 10, mrpPerUnitPaise: 500, purchaseRatePaise: 400 }]))).status).toBe(201)
    const payload = body([
      { medicationId: b, batchNo: 'NEW-1', expiryDate: FUTURE, quantity: 5, mrpPerUnitPaise: 100, purchaseRatePaise: 50 },
      { medicationId: a, batchNo: 'B1', expiryDate: '2099-01-31', quantity: 10, mrpPerUnitPaise: 500, purchaseRatePaise: 400 },
    ])
    const res = await post(payload)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('batch_conflict')
    expect(await grnCountFor(payload.supplierInvoiceNo)).toBe(0)
    expect(await getDb().select().from(medicationBatches).where(eq(medicationBatches.medicationId, b))).toEqual([])
    expect(await onHand(a)).toBe(10)
    expect(await onHand(b)).toBe(0)
  })

  it('refuses the same batch number with a different MRP with 409', async () => {
    const a = await seedMed(0)
    expect((await post(body([{ medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 10, mrpPerUnitPaise: 500, purchaseRatePaise: 400 }]))).status).toBe(201)
    const res = await post(body([{ medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 10, mrpPerUnitPaise: 550, purchaseRatePaise: 400 }]))
    expect(res.status).toBe(409)
  })

  it('refuses an unknown medication with 422', async () => {
    const res = await post(body([{ medicationId: 2147483000, batchNo: 'X1', expiryDate: FUTURE, quantity: 1, mrpPerUnitPaise: 1, purchaseRatePaise: 1 }]))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('unknown_medication')
  })

  it('rejects an unknown body key, an unknown line key and a bad batch number with 400', async () => {
    const a = await seedMed(0)
    const line = { medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 1, mrpPerUnitPaise: 1, purchaseRatePaise: 1 }
    expect((await post(body([line], { extra: 1 }))).status).toBe(400)
    expect((await post(body([{ ...line, gst: 12 } as Line]))).status).toBe(400)
    expect((await post(body([{ ...line, batchNo: 'B 1' }]))).status).toBe(400)
    expect((await post(body([]))).status).toBe(400)
  })

  it('denies frontdesk and billing with 403 on both methods', async () => {
    const a = await seedMed(0)
    for (const role of ['frontdesk', 'billing'] as const) {
      sessionRole = role
      expect((await post(body([{ medicationId: a, batchNo: 'B1', expiryDate: FUTURE, quantity: 1, mrpPerUnitPaise: 1, purchaseRatePaise: 1 }]))).status).toBe(403)
      expect((await list()).status).toBe(403)
    }
    expect(await onHand(a)).toBe(0)
  })
})

describe('GET /api/pharmacy/grns', () => {
  it('lists recent GRNs, newest first, with total and line count', async () => {
    const a = await seedMed(0)
    const res = await post(body([
      { medicationId: a, batchNo: 'L1', expiryDate: FUTURE, quantity: 4, mrpPerUnitPaise: 300, purchaseRatePaise: 125 },
      { medicationId: a, batchNo: 'L2', expiryDate: FUTURE, quantity: 6, mrpPerUnitPaise: 300, purchaseRatePaise: 150 },
    ]))
    const { grnId, grnNumber } = await res.json()
    const listed = await list()
    expect(listed.status).toBe(200)
    const { items } = await listed.json()
    expect(items[0]).toMatchObject({ id: grnId, grnNumber, supplierName: 'Sri Venkateswara Pharma Distributors', totalPaise: 4 * 125 + 6 * 150, lineCount: 2 })
    expect(typeof items[0].receivedAt).toBe('string')
    expect(Object.keys(items[0]).sort()).toEqual(['grnNumber', 'id', 'lineCount', 'receivedAt', 'supplierInvoiceNo', 'supplierName', 'totalPaise'])
  })
})
