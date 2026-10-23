import { describe, it, expect, vi, afterEach } from 'vitest'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { POST as dispenseRoute } from '@/app/api/pharmacy/dispense/route'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses, medicationBatches, chargeLines } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' = 'pi'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam', userId: null })) }))

const createdMedIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  // WS5 T5: dispenses now reference batches, so clean up by drug: charge lines (WS2 T8: a dispense
  // bills itself), dispenses, batches, inventory, drug.
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(chargeLines).where(inArray(chargeLines.medicationDispenseId, getDb().select({ id: medicationDispenses.id }).from(medicationDispenses).where(eq(medicationDispenses.medicationId, id))))
    await getDb().delete(medicationDispenses).where(eq(medicationDispenses.medicationId, id))
    await getDb().delete(medicationBatches).where(eq(medicationBatches.medicationId, id))
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

async function makeMedWithStock(qty: number) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Route Test Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet', mrpPerUnitPaise: 200 }).returning() // WS2 T8: priced
  createdMedIds.push(med.id)
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: qty, reorderThreshold: 5, unit: 'tablets' })
  return med
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/pharmacy/dispense', () => {
  it('dispenses successfully as pi', async () => {
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5, notes: 'Test dispense', batchNo: 'B1', expiryMonth: '2099-12' }) as never)
    expect(res.status).toBe(201)
  })

  it('dispenses successfully as pharmacy', async () => {
    sessionRole = 'pharmacy'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5, notes: 'Test dispense', batchNo: 'B1', expiryMonth: '2099-12' }) as never)
    expect(res.status).toBe(201)
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(403)
  })

  it('rejects a crc session', async () => {
    sessionRole = 'crc'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(403)
  })

  it('rejects dispensing more than on hand', async () => {
    const med = await makeMedWithStock(3)
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 10, batchNo: 'B1', expiryMonth: '2099-12' }) as never)
    expect(res.status).toBe(409)
  })

  it('rejects an unknown patientId with a clean 400 and leaves stock untouched', async () => {
    const med = await makeMedWithStock(30)
    const res = await dispenseRoute(req({ patientId: 'rd-does-not-exist', medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Unknown patient')

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(30)
  })

  it('rejects an unknown medicationId with a clean 400 (not the old misleading 409) and leaves stock untouched', async () => {
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: 999999999, quantity: 5 }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Unknown medication')
  })
})

// WS5 T5: dispensing draws from batches, FEFO or a picked batch.
type BatchSeed = { batchNo: string; expiryDate: string | null; qty: number; mrp?: number; writtenOff?: boolean }

async function makeMedWithBatches(seeds: BatchSeed[]) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Route Test Batched Med ${Date.now()}-${Math.random()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  createdMedIds.push(med.id)
  const live = seeds.filter((b) => !b.writtenOff).reduce((s, b) => s + b.qty, 0)
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: live, reorderThreshold: 5, unit: 'tablets' })
  const batches = await db.insert(medicationBatches).values(seeds.map((b) => ({
    medicationId: med.id, batchNo: b.batchNo, expiryDate: b.expiryDate, mrpPerUnitPaise: b.mrp ?? 1000,
    quantityOnHand: b.writtenOff ? 0 : b.qty, writtenOffAt: b.writtenOff ? new Date() : null, writeOffReason: b.writtenOff ? 'damaged' : null,
  }))).returning()
  return { med, batches }
}

async function firstPatientId() {
  const [row] = await getDb().select({ id: patients.id }).from(patients).limit(1)
  return row.id
}

async function expectOnHandEqualsLiveBatches(medicationId: number) {
  const [inv] = await getDb().select({ q: medicationInventory.quantityOnHand }).from(medicationInventory).where(eq(medicationInventory.medicationId, medicationId))
  const [sum] = await getDb().select({ s: sql<number>`COALESCE(SUM(${medicationBatches.quantityOnHand}), 0)::int` }).from(medicationBatches)
    .where(and(eq(medicationBatches.medicationId, medicationId), isNull(medicationBatches.writtenOffAt)))
  expect(sum.s).toBe(inv.q)
  return inv.q
}

async function dispenseRows(medicationId: number) {
  return getDb().select().from(medicationDispenses).where(eq(medicationDispenses.medicationId, medicationId)).orderBy(medicationDispenses.id)
}

describe('POST /api/pharmacy/dispense -- batches (WS5 T5)', () => {
  it('FEFO across two batches writes one dispense row per batch, earliest expiry first', async () => {
    const { med, batches: [later, sooner] } = await makeMedWithBatches([
      { batchNo: 'LATE-1', expiryDate: '2031-06-30', qty: 10, mrp: 1200 },
      { batchNo: 'SOON-1', expiryDate: '2030-12-31', qty: 4, mrp: 1000 },
    ])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 6 }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ids).toHaveLength(2)
    expect(body.id).toBe(body.ids[0])
    expect(body.allocations).toEqual([
      { dispenseId: body.ids[0], batchId: sooner.id, batchNo: 'SOON-1', expiryMonth: '2030-12', quantity: 4 },
      { dispenseId: body.ids[1], batchId: later.id, batchNo: 'LATE-1', expiryMonth: '2031-06', quantity: 2 },
    ])
    const rows = await dispenseRows(med.id)
    expect(rows.map((r) => [r.id, r.batchId, r.quantity])).toEqual([[body.ids[0], sooner.id, 4], [body.ids[1], later.id, 2]])
    // Merge WS2 x WS5: each row carries its batch snapshot and bills itself at that batch's MRP.
    expect(rows.map((r) => [r.batchNo, r.expiryMonth, r.unitMrpPaise])).toEqual([['SOON-1', '2030-12', 1000], ['LATE-1', '2031-06', 1200]])
    const lines = await getDb().select().from(chargeLines).where(inArray(chargeLines.medicationDispenseId, body.ids)).orderBy(chargeLines.id)
    expect(lines.map((l) => [l.medicationDispenseId, l.quantity, l.unitPricePaise > 0, l.itemName.endsWith('(Batch SOON-1, Exp 12/2030)') || l.itemName.endsWith('(Batch LATE-1, Exp 06/2031)')]))
      .toEqual([[body.ids[0], 4, true, true], [body.ids[1], 2, true, true]])
    expect(body.charges).toHaveLength(2)
    expect(body.charge.totalPaise).toBe(body.charges[0].totalPaise + body.charges[1].totalPaise)
    const after = await getDb().select().from(medicationBatches).where(eq(medicationBatches.medicationId, med.id)).orderBy(medicationBatches.id)
    expect(after.map((b) => b.quantityOnHand)).toEqual([8, 0])
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(8)
  })

  it('a picked batch is used even when it is not the FEFO one', async () => {
    const { med, batches: [later] } = await makeMedWithBatches([
      { batchNo: 'LATE-2', expiryDate: '2031-06-30', qty: 10 },
      { batchNo: 'SOON-2', expiryDate: '2030-12-31', qty: 10 },
    ])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 3, batchId: later.id }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.allocations).toEqual([{ dispenseId: body.id, batchId: later.id, batchNo: 'LATE-2', expiryMonth: '2031-06', quantity: 3 }])
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(17)
  })

  it('refuses a picked expired batch with 409 batch_expired and writes nothing', async () => {
    const { med, batches: [expired] } = await makeMedWithBatches([
      { batchNo: 'OLD-1', expiryDate: '2020-01-31', qty: 10 },
      { batchNo: 'NEW-1', expiryDate: '2031-01-31', qty: 10 },
    ])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 2, batchId: expired.id }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('batch_expired')
    expect(await dispenseRows(med.id)).toEqual([])
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(20)
  })

  it('refuses a picked written-off batch with 409 insufficient_stock', async () => {
    const { med, batches: [gone] } = await makeMedWithBatches([
      { batchNo: 'GONE-1', expiryDate: '2031-01-31', qty: 10, writtenOff: true },
      { batchNo: 'NEW-2', expiryDate: '2031-01-31', qty: 10 },
    ])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 2, batchId: gone.id }) as never)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('insufficient_stock')
    expect(body.error).toBe('Not enough stock on hand for this quantity')
    expect(await dispenseRows(med.id)).toEqual([])
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(10)
  })

  it("refuses another drug's batch with 400 batch_mismatch", async () => {
    const { med } = await makeMedWithBatches([{ batchNo: 'MINE-1', expiryDate: '2031-01-31', qty: 10 }])
    const { batches: [theirs] } = await makeMedWithBatches([{ batchNo: 'THEIRS-1', expiryDate: '2031-01-31', qty: 10 }])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 2, batchId: theirs.id }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('batch_mismatch')
    expect(await dispenseRows(med.id)).toEqual([])
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(10)
  })

  it('refuses with 409 only_expired_stock when only expired stock would cover the quantity', async () => {
    const { med } = await makeMedWithBatches([
      { batchNo: 'OLD-2', expiryDate: '2020-01-31', qty: 10 },
      { batchNo: 'NEW-3', expiryDate: '2031-01-31', qty: 2 },
    ])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('only_expired_stock')
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(12)
  })

  it('two parallel dispenses of the last 5 units: one 201, one 409', async () => {
    const { med } = await makeMedWithBatches([{ batchNo: 'LAST-1', expiryDate: '2031-01-31', qty: 5 }])
    const patientId = await firstPatientId()
    const results = await Promise.all([
      dispenseRoute(req({ patientId, medicationId: med.id, quantity: 5 }) as never),
      dispenseRoute(req({ patientId, medicationId: med.id, quantity: 5 }) as never),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    const refused = results.find((r) => r.status === 409)!
    expect((await refused.json()).code).toBe('insufficient_stock')
    expect(await dispenseRows(med.id)).toHaveLength(1)
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(0)
  })

  it('stock held without a batch goes into the OPENING batch and the dispense row points at it', async () => {
    const med = await makeMedWithStock(30)
    // Merge WS2 x WS5: the OPENING batch has no number or expiry, so a charged dispense from it
    // still needs the strip's batch and expiry (422 batch_required, nothing taken) ...
    const noStrip = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 5 }) as never)
    expect(noStrip.status).toBe(422)
    expect((await noStrip.json()).code).toBe('batch_required')
    expect(await dispenseRows(med.id)).toEqual([])
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 5, batchNo: 'STRIP-9', expiryMonth: '2099-12' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    const [opening] = await getDb().select().from(medicationBatches).where(eq(medicationBatches.medicationId, med.id))
    expect(opening.batchNo).toBe('OPENING')
    expect(opening.mrpPerUnitPaise).toBe(0)
    expect(body.allocations).toEqual([{ dispenseId: body.id, batchId: opening.id, batchNo: 'OPENING', expiryMonth: null, quantity: 5 }])
    expect(await expectOnHandEqualsLiveBatches(med.id)).toBe(25)
    // ... and the row snapshots the strip and the catalogue MRP (200), since the OPENING MRP is 0.
    const [row] = await dispenseRows(med.id)
    expect(row).toMatchObject({ batchId: opening.id, batchNo: 'STRIP-9', expiryMonth: '2099-12', unitMrpPaise: 200 })
    expect(body.charge).toMatchObject({ quantity: 5, unitMrpPaise: 200 })
  })

  it('a drug with no batches and no stock is refused as before', async () => {
    const med = await makeMedWithStock(0)
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 1 }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Not enough stock on hand for this quantity')
  })

  it('refuses with 409 opening_batch_written_off when unbatched stock has nowhere to go', async () => {
    const { med } = await makeMedWithBatches([{ batchNo: 'OPENING', expiryDate: null, qty: 0, writtenOff: true }])
    await getDb().update(medicationInventory).set({ quantityOnHand: 10 }).where(eq(medicationInventory.medicationId, med.id))
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 1 }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('opening_batch_written_off')
    expect(await dispenseRows(med.id)).toEqual([])
  })

  it('rejects a non-integer batchId', async () => {
    const med = await makeMedWithStock(5)
    const res = await dispenseRoute(req({ patientId: await firstPatientId(), medicationId: med.id, quantity: 1, batchId: 'B1' }) as never)
    expect(res.status).toBe(400)
  })
})
