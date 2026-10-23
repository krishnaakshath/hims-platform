import { describe, it, expect, afterEach } from 'vitest'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { medications, medicationInventory, medicationBatches, medicationDispenses } from '@/db/schema'
import { listBatches, syncInventoryTotal } from '@/lib/queries/medication-batches'
import { readMigration, idempotencyProblems, missingColumns } from '../../db/migration-sql'

const MIGRATION = '2026-10-25-ws5-medication-batches.sql'

// The migration body without its own BEGIN/COMMIT, so a test can run it inside a
// transaction it rolls back (the shared test DB keeps no rows from this file).
function migrationBody(): string {
  return readMigration(MIGRATION).replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
}

async function withRolledBackClient(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    await c.query('BEGIN')
    await fn(c)
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

async function makeMed(c: pg.Client, label: string, qty: number): Promise<number> {
  const r = await c.query(`INSERT INTO medications (name, medication_class, form) VALUES ($1, 'Test', 'tablet') RETURNING id`, [`WS5 T2 ${label} ${Date.now()}`])
  const id = r.rows[0].id as number
  await c.query(`INSERT INTO medication_inventory (medication_id, quantity_on_hand) VALUES ($1, $2)`, [id, qty])
  return id
}

async function batchRows(c: pg.Client) {
  const r = await c.query(`SELECT id, medication_id, batch_no, expiry_date, mrp_per_unit_paise, quantity_on_hand, written_off_at FROM medication_batches ORDER BY id`)
  return r.rows
}

describe('WS5 T2 migration (medication batches)', () => {
  it('is idempotent and declares every column, constraint and index', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(missingColumns(medicationBatches, s)).toEqual([])
    expect(s).toMatch(/ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS batch_id integer;/)
    const c = getTableConfig(medicationBatches)
    const names = [
      // WS5 T3: the grn_id FK is created by 2026-10-25-ws5-pharmacy-grns.sql (pinned in tests/api/pharmacy-grns.test.ts).
      ...c.foreignKeys.map((f) => f.getName()).filter((n) => n !== 'medication_batches_grn_id_pharmacy_grns_id_fk'), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
      ...c.uniqueConstraints.map((u) => u.getName()!),
      ...getTableConfig(medicationDispenses).foreignKeys.map((f) => f.getName()).filter((n) => n.includes('batch')),
    ]
    expect(names).toContain('medication_dispenses_batch_id_medication_batches_id_fk')
    for (const n of names) {
      expect(n.length, n).toBeLessThanOrEqual(63)
      expect(s, n).toContain(n)
    }
  })

  it('backfills an OPENING batch for every drug with stock; a second run changes nothing', async () => {
    await withRolledBackClient(async (c) => {
      const stocked = await makeMed(c, 'stocked', 37)
      const empty = await makeMed(c, 'empty', 0)
      await c.query(migrationBody())

      const missing = await c.query(`
        SELECT inv.medication_id FROM medication_inventory inv
        WHERE inv.quantity_on_hand > 0
          AND NOT EXISTS (SELECT 1 FROM medication_batches b WHERE b.medication_id = inv.medication_id AND b.batch_no = 'OPENING')`)
      expect(missing.rows).toEqual([])

      const mine = await c.query(`SELECT medication_id, batch_no, expiry_date, mrp_per_unit_paise, quantity_on_hand, written_off_at
        FROM medication_batches WHERE medication_id = ANY($1::int[])`, [[stocked, empty]])
      expect(mine.rows).toEqual([{ medication_id: stocked, batch_no: 'OPENING', expiry_date: null, mrp_per_unit_paise: 0, quantity_on_hand: 37, written_off_at: null }])
      const sum = await c.query(`SELECT COALESCE(SUM(quantity_on_hand), 0)::int AS s FROM medication_batches WHERE medication_id = $1`, [stocked])
      expect(sum.rows[0].s).toBe(37)

      const before = await batchRows(c)
      await c.query(migrationBody())
      expect(await batchRows(c)).toEqual(before)
    })
  })

  it("uses medications.mrp_per_unit_paise for the OPENING batch when WS2's column exists", async () => {
    await withRolledBackClient(async (c) => {
      await c.query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS mrp_per_unit_paise integer`)
      const id = await makeMed(c, 'mrp', 5)
      await c.query(`UPDATE medications SET mrp_per_unit_paise = 250 WHERE id = $1`, [id])
      await c.query(migrationBody())
      const r = await c.query(`SELECT mrp_per_unit_paise, quantity_on_hand FROM medication_batches WHERE medication_id = $1`, [id])
      expect(r.rows).toEqual([{ mrp_per_unit_paise: 250, quantity_on_hand: 5 }])
    })
  })

  it('rejects a negative quantity or MRP and a duplicate batch number', async () => {
    await withRolledBackClient(async (c) => {
      const id = await makeMed(c, 'checks', 0)
      await c.query('SAVEPOINT s')
      await expect(c.query(`INSERT INTO medication_batches (medication_id, batch_no, mrp_per_unit_paise, quantity_on_hand) VALUES ($1, 'X', 0, -1)`, [id])).rejects.toThrow(/medication_batches_quantity_nonneg/)
      await c.query('ROLLBACK TO SAVEPOINT s')
      await expect(c.query(`INSERT INTO medication_batches (medication_id, batch_no, mrp_per_unit_paise, quantity_on_hand) VALUES ($1, 'X', -1, 0)`, [id])).rejects.toThrow(/medication_batches_mrp_nonneg/)
      await c.query('ROLLBACK TO SAVEPOINT s')
      await c.query(`INSERT INTO medication_batches (medication_id, batch_no, mrp_per_unit_paise, quantity_on_hand) VALUES ($1, 'X', 0, 1)`, [id])
      await expect(c.query(`INSERT INTO medication_batches (medication_id, batch_no, mrp_per_unit_paise, quantity_on_hand) VALUES ($1, 'X', 0, 1)`, [id])).rejects.toThrow(/medication_batches_medication_batch_unique/)
    })
  })
})

describe('medication batch queries', () => {
  const medIds: number[] = []
  afterEach(async () => {
    const db = getDb()
    while (medIds.length > 0) {
      const id = medIds.pop()!
      await db.delete(medicationBatches).where(eq(medicationBatches.medicationId, id))
      await db.delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
      await db.delete(medications).where(eq(medications.id, id))
    }
  })

  async function seedMed(qty: number): Promise<number> {
    const db = getDb()
    const [m] = await db.insert(medications).values({ name: `WS5 T2 query ${Date.now()}`, medicationClass: 'Test', form: 'tablet' }).returning()
    medIds.push(m.id)
    await db.insert(medicationInventory).values({ medicationId: m.id, quantityOnHand: qty })
    return m.id
  }

  it('listBatches returns BatchStock rows, earliest expiry first and no-expiry last', async () => {
    const id = await seedMed(0)
    const db = getDb()
    await db.insert(medicationBatches).values([
      { medicationId: id, batchNo: 'OPENING', expiryDate: null, mrpPerUnitPaise: 0, quantityOnHand: 4 },
      { medicationId: id, batchNo: 'B-LATE', expiryDate: '2027-06-30', mrpPerUnitPaise: 1200, quantityOnHand: 10 },
      { medicationId: id, batchNo: 'B-SOON', expiryDate: '2026-12-31', mrpPerUnitPaise: 1100, quantityOnHand: 6, writtenOffAt: new Date(), writeOffReason: 'damaged' },
    ])
    const rows = await listBatches(id)
    expect(rows.map((b) => ({ batchNo: b.batchNo, expiryDate: b.expiryDate, quantityOnHand: b.quantityOnHand, mrpPerUnitPaise: b.mrpPerUnitPaise, writtenOff: b.writtenOff }))).toEqual([
      { batchNo: 'B-SOON', expiryDate: '2026-12-31', quantityOnHand: 6, mrpPerUnitPaise: 1100, writtenOff: true },
      { batchNo: 'B-LATE', expiryDate: '2027-06-30', quantityOnHand: 10, mrpPerUnitPaise: 1200, writtenOff: false },
      { batchNo: 'OPENING', expiryDate: null, quantityOnHand: 4, mrpPerUnitPaise: 0, writtenOff: false },
    ])
    expect(rows.every((b) => typeof b.id === 'number')).toBe(true)
  })

  it('syncInventoryTotal sets on-hand to the sum of non-written-off batches', async () => {
    const id = await seedMed(999)
    const db = getDb()
    await db.insert(medicationBatches).values([
      { medicationId: id, batchNo: 'A', expiryDate: '2027-01-31', mrpPerUnitPaise: 100, quantityOnHand: 7 },
      { medicationId: id, batchNo: 'B', expiryDate: null, mrpPerUnitPaise: 100, quantityOnHand: 5 },
      { medicationId: id, batchNo: 'C', expiryDate: '2026-12-31', mrpPerUnitPaise: 100, quantityOnHand: 3, writtenOffAt: new Date(), writeOffReason: 'expired' },
    ])
    await db.transaction(async (tx) => { await syncInventoryTotal(tx, id) })
    const [inv] = await db.select().from(medicationInventory).where(eq(medicationInventory.medicationId, id))
    expect(inv.quantityOnHand).toBe(12)

    await db.delete(medicationBatches).where(eq(medicationBatches.medicationId, id))
    await db.transaction(async (tx) => { await syncInventoryTotal(tx, id) })
    const [after] = await db.select().from(medicationInventory).where(eq(medicationInventory.medicationId, id))
    expect(after.quantityOnHand).toBe(0)
  })
})
