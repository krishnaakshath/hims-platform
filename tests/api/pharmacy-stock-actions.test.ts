import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { PATCH as patchReorder } from '@/app/api/pharmacy/medications/[id]/reorder/route'
import { POST as postWriteOff } from '@/app/api/pharmacy/batches/[id]/write-off/route'
import { POST as postLink } from '@/app/api/pharmacy/uncatalogued/link/route'
import { getDb } from '@/db/client'
import { medications, medicationInventory, medicationBatches, medicationEpisodes, patients, auditLog } from '@/db/schema'
import { listMedicationsWithInventory, listActiveMedicationEpisodeSummary } from '@/lib/queries/medications'
import { loadPharmacyKpis } from '@/lib/queries/hospital-kpis'
import { matchesStockFilter } from '@/components/dashboards/PharmacyDashboard'
import { todayIsoIn } from '@/lib/india-time'
import { addDaysIso } from '@/lib/follow-ups/rules'

let sessionRole: 'admin' | 'pharmacy' | 'pi' | 'frontdesk' = 'pharmacy'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'WS5 T4 Pharmacist' })) }))

const medIds: number[] = []
const episodeIds: number[] = []
afterEach(async () => {
  sessionRole = 'pharmacy'
  const db = getDb()
  if (episodeIds.length > 0) await db.delete(medicationEpisodes).where(inArray(medicationEpisodes.id, episodeIds))
  if (medIds.length > 0) {
    await db.delete(medicationBatches).where(inArray(medicationBatches.medicationId, medIds))
    await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, medIds))
    await db.delete(medications).where(inArray(medications.id, medIds))
  }
  medIds.length = 0
  episodeIds.length = 0
})

type Batch = { batchNo: string; qty: number; expiry?: string | null }
/** A drug whose on-hand total is `onHand` (default: the sum of its batches). */
async function seedMed(batches: Batch[], { onHand, reorderThreshold = 10 }: { onHand?: number; reorderThreshold?: number } = {}) {
  const db = getDb()
  const [m] = await db.insert(medications).values({ name: `WS5 T4 stock ${Date.now()}-${Math.random()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  medIds.push(m.id)
  const sum = batches.reduce((s, b) => s + b.qty, 0)
  await db.insert(medicationInventory).values({ medicationId: m.id, quantityOnHand: onHand ?? sum, reorderThreshold })
  const ids: number[] = []
  for (const b of batches) {
    const [row] = await db.insert(medicationBatches).values({ medicationId: m.id, batchNo: b.batchNo, expiryDate: b.expiry ?? null, mrpPerUnitPaise: 250, quantityOnHand: b.qty }).returning()
    ids.push(row.id)
  }
  return { medicationId: m.id, batchIds: ids }
}

const send = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const writeOff = (batchId: number | string, body: unknown) => postWriteOff(send('POST', `/api/pharmacy/batches/${batchId}/write-off`, body), ctx(batchId))
const reorder = (medicationId: number | string, body: unknown) => patchReorder(send('PATCH', `/api/pharmacy/medications/${medicationId}/reorder`, body), ctx(medicationId))
const link = (body: unknown) => postLink(send('POST', '/api/pharmacy/uncatalogued/link', body))

async function onHand(medicationId: number): Promise<number> {
  const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, medicationId))
  return inv.quantityOnHand
}
async function lastAudit(action: string) {
  const [row] = await getDb().select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1)
  return row
}

describe('POST /api/pharmacy/batches/[id]/write-off', () => {
  it('lowers the total by exactly the batch quantity, records the reason, and audits ids and counts only', async () => {
    const { medicationId, batchIds: [a, b] } = await seedMed([{ batchNo: 'A1', qty: 30, expiry: '2099-01-31' }, { batchNo: 'B1', qty: 12, expiry: '2099-06-30' }])
    const res = await writeOff(b, { reason: 'damaged', note: 'Strip crushed in transit, Ramesh Kumar' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await onHand(medicationId)).toBe(30)
    const [row] = await getDb().select().from(medicationBatches).where(eq(medicationBatches.id, b))
    expect(row.quantityOnHand).toBe(0)
    expect(row.writtenOffAt).not.toBeNull()
    expect(row.writeOffReason).toBe('damaged')
    const [other] = await getDb().select().from(medicationBatches).where(eq(medicationBatches.id, a))
    expect(other.quantityOnHand).toBe(30)
    const audit = await lastAudit('pharmacy: wrote off batch')
    expect(audit.details).toBe(`batch=${b} qty=12 reason=damaged`)
  })

  it('a second write-off of the same batch is refused with 409 and changes nothing', async () => {
    const { medicationId, batchIds: [a] } = await seedMed([{ batchNo: 'A1', qty: 8, expiry: '2099-01-31' }, { batchNo: 'B1', qty: 5, expiry: '2099-06-30' }])
    expect((await writeOff(a, { reason: 'expired' })).status).toBe(200)
    const again = await writeOff(a, { reason: 'other' })
    expect(again.status).toBe(409)
    expect(await onHand(medicationId)).toBe(5)
    const [row] = await getDb().select().from(medicationBatches).where(eq(medicationBatches.id, a))
    expect(row.writeOffReason).toBe('expired')
  })

  it('reconciles unbatched stock first (ruling R7): stock outside any batch survives in the OPENING batch', async () => {
    const { medicationId, batchIds: [a] } = await seedMed([{ batchNo: 'A1', qty: 30, expiry: '2099-01-31' }], { onHand: 50 })
    expect((await writeOff(a, { reason: 'recalled' })).status).toBe(200)
    expect(await onHand(medicationId)).toBe(20)
    const [opening] = await getDb().select().from(medicationBatches)
      .where(and(eq(medicationBatches.medicationId, medicationId), eq(medicationBatches.batchNo, 'OPENING')))
    expect(opening.quantityOnHand).toBe(20)
  })

  it('400 for a bad reason or a long note, 404 for an unknown batch, 403 for a view-only role', async () => {
    const { batchIds: [a] } = await seedMed([{ batchNo: 'A1', qty: 3 }])
    expect((await writeOff(a, { reason: 'lost' })).status).toBe(400)
    expect((await writeOff(a, { reason: 'other', note: 'x'.repeat(201) })).status).toBe(400)
    expect((await writeOff(a, { reason: 'other', extra: 1 })).status).toBe(400)
    expect((await writeOff(2147483000, { reason: 'other' })).status).toBe(404)
    expect((await writeOff('abc', { reason: 'other' })).status).toBe(400)
    sessionRole = 'pi'
    expect((await writeOff(a, { reason: 'other' })).status).toBe(403)
    sessionRole = 'frontdesk'
    expect((await writeOff(a, '{not json')).status).toBe(403)
  })
})

describe('PATCH /api/pharmacy/medications/[id]/reorder', () => {
  it('persists the reorder level, and ?stock=low uses it', async () => {
    const { medicationId } = await seedMed([{ batchNo: 'A1', qty: 40, expiry: '2099-01-31' }], { reorderThreshold: 10 })
    const before = (await listMedicationsWithInventory()).find((m) => m.id === medicationId)!
    expect(matchesStockFilter(before, 'low')).toBe(false)

    const res = await reorder(medicationId, { reorderThreshold: 50 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reorderThreshold: 50 })
    const after = (await listMedicationsWithInventory()).find((m) => m.id === medicationId)!
    expect(after.reorderThreshold).toBe(50)
    expect(matchesStockFilter(after, 'low')).toBe(true)
    expect((await lastAudit('pharmacy: changed reorder level')).details).toBe(`medication=${medicationId} reorder=50`)
  })

  it('400 out of range, 404 unknown medication, 403 for pi', async () => {
    const { medicationId } = await seedMed([])
    expect((await reorder(medicationId, { reorderThreshold: -1 })).status).toBe(400)
    expect((await reorder(medicationId, { reorderThreshold: 100001 })).status).toBe(400)
    expect((await reorder(medicationId, { reorderThreshold: 1.5 })).status).toBe(400)
    expect((await reorder(2147483000, { reorderThreshold: 5 })).status).toBe(404)
    sessionRole = 'pi'
    expect((await reorder(medicationId, { reorderThreshold: 5 })).status).toBe(403)
  })
})

describe('stock view fields and expiry KPIs', () => {
  it('batches, nearest expiry, expiring-soon and expired quantities (IST today); written-off stock is ignored', async () => {
    const today = todayIsoIn()
    const { medicationId, batchIds: [, , , gone] } = await seedMed([
      { batchNo: 'OLD', qty: 4, expiry: addDaysIso(today, -3) },
      { batchNo: 'SOON', qty: 6, expiry: addDaysIso(today, 23) },
      { batchNo: 'LATER', qty: 9, expiry: addDaysIso(today, 200) },
      { batchNo: 'GONE', qty: 5, expiry: addDaysIso(today, 10) },
    ])
    const base = await loadPharmacyKpis(today)
    expect((await writeOff(gone, { reason: 'damaged' })).status).toBe(200)
    const m = (await listMedicationsWithInventory()).find((r) => r.id === medicationId)!
    expect(m.batches.map((b) => b.batchNo)).toEqual(['OLD', 'GONE', 'SOON', 'LATER'])
    expect(m.nearestExpiry).toBe(addDaysIso(today, -3))
    expect(m.expiringSoonQty).toBe(6)
    expect(m.expiredQty).toBe(4)
    expect(matchesStockFilter(m, 'expiring')).toBe(true)
    expect(matchesStockFilter(m, 'expired')).toBe(true)
    const after = await loadPharmacyKpis(today)
    expect(after.expiringIn90Days - base.expiringIn90Days).toBe(-1)
    expect(after.expiredBatches - base.expiredBatches).toBe(0)
  })
})

describe('POST /api/pharmacy/uncatalogued/link', () => {
  it('links the active, unlinked episodes with exactly that name, and the drug leaves the not-in-catalogue list', async () => {
    const db = getDb()
    const { medicationId } = await seedMed([])
    const [p] = await db.select({ id: patients.id }).from(patients).limit(1)
    const name = `WS5 T4 Paracetemol ${Date.now()}`
    const base = { patientId: p.id, medicationClass: 'Analgesic', startDate: '2026-10-01' }
    const rows = await db.insert(medicationEpisodes).values([
      { ...base, name, status: 'active' },
      { ...base, name, status: 'active' },
      { ...base, name, status: 'inactive' },
      { ...base, name: name.toLowerCase(), status: 'active' },
    ]).returning({ id: medicationEpisodes.id })
    episodeIds.push(...rows.map((r) => r.id))
    expect((await listActiveMedicationEpisodeSummary()).find((r) => r.name === name)?.inCatalog).toBe(false)

    const res = await link({ episodeName: name, medicationId })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ linked: 2 })
    const after = await db.select().from(medicationEpisodes).where(inArray(medicationEpisodes.id, episodeIds))
    const byId = new Map(after.map((e) => [e.id, e.medicationId]))
    expect(rows.map((r) => byId.get(r.id))).toEqual([medicationId, medicationId, null, null])
    expect((await listActiveMedicationEpisodeSummary()).find((r) => r.name === name)?.inCatalog).toBe(true)
    expect((await lastAudit('pharmacy: linked uncatalogued prescriptions')).details).toBe(`medication=${medicationId} linked=2`)

    // Nothing left to link: a second call links none.
    expect(await (await link({ episodeName: name, medicationId })).json()).toEqual({ linked: 0 })
  })

  it('422 for an unknown medication, 400 for a bad body, 403 for pi', async () => {
    expect((await link({ episodeName: 'Anything', medicationId: 2147483000 })).status).toBe(422)
    expect((await link({ episodeName: '', medicationId: 1 })).status).toBe(400)
    expect((await link({ episodeName: 'x'.repeat(201), medicationId: 1 })).status).toBe(400)
    sessionRole = 'pi'
    expect((await link({ episodeName: 'Anything', medicationId: 1 })).status).toBe(403)
  })
})
