// Tariff routes against the real query layer, real audit and real Postgres (exclusion constraint
// included). Only the session is faked. Fixtures are TEST_SP2_-prefixed and deleted by id;
// audit rows by this run's unique probe user name.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, departments, roomCategories, serviceCatalog, servicePackageItems, tariffRates } from '@/db/schema'

const RUN = `${Date.now()}`.slice(-6)
const PROBE_USER = `TEST_SP2_R89-${Date.now()}`

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'billing', name: PROBE_USER, userId: null })) }
})

import { POST as postService } from '@/app/api/tariff/services/route'
import { POST as postCategory } from '@/app/api/tariff/room-categories/route'
import { POST as postRate } from '@/app/api/tariff/rates/route'
import { PATCH as patchRate } from '@/app/api/tariff/rates/[id]/route'
import { POST as revise } from '@/app/api/tariff/rates/[id]/revise/route'
import { PUT as putItems } from '@/app/api/tariff/packages/[id]/items/route'

const req = (method: string, path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: JSON.stringify(body) })
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })
const OVERLAP = { error: 'This rate overlaps an existing rate for the same service, scope and room/ward' }

describe.skipIf(!process.env.DATABASE_URL)('tariff routes (DB)', () => {
  const ids = { services: [] as number[], cats: [] as number[], depts: [] as number[] }

  afterEach(async () => {
    const db = getDb()
    const services = ids.services.splice(0)
    if (services.length) {
      await db.delete(tariffRates).where(inArray(tariffRates.serviceId, services))
      await db.delete(servicePackageItems).where(inArray(servicePackageItems.packageServiceId, services))
      await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, services))
    }
    if (ids.cats.length) await db.delete(roomCategories).where(inArray(roomCategories.id, ids.cats.splice(0)))
    if (ids.depts.length) await db.delete(departments).where(inArray(departments.id, ids.depts.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  const actions = async () => (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).map((a) => a.action)

  async function dept() {
    const [d] = await getDb().insert(departments).values({ code: `TEST_SP2_D${RUN}`, name: 'Test SP2 R89 Dept', kind: 'clinical' }).returning()
    ids.depts.push(d.id)
    return d.id
  }

  async function service(code: string, departmentId: number, category = 'procedure') {
    const res = await postService(req('POST', '/api/tariff/services', { code, name: `Test ${code}`, departmentId, category, hsnSac: '999311', gstRateBp: 1800 }))
    expect(res.status).toBe(201)
    const row = await res.json()
    ids.services.push(row.id)
    return row as { id: number; code: string }
  }

  it('creates a service and a room category with the audit row committed alongside; duplicates 409 with no extra audit', async () => {
    const d = await dept()
    const s = await service(`TEST_SP2_R89_S${RUN}`, d)
    const dup = await postService(req('POST', '/api/tariff/services', { code: s.code, name: 'Again', departmentId: d, category: 'procedure', hsnSac: '999311', gstRateBp: 0 }))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'Service code already exists' })

    const cat = await postCategory(req('POST', '/api/tariff/room-categories', { code: `TEST_SP2_C${RUN}`, name: 'Test cat' }))
    expect(cat.status).toBe(201)
    ids.cats.push((await cat.json()).id)
    expect((await postCategory(req('POST', '/api/tariff/room-categories', { code: `TEST_SP2_C${RUN}`, name: 'Again' }))).status).toBe(409)

    expect((await actions()).sort()).toEqual([`tariff: created room category TEST_SP2_C${RUN}`, `tariff: created service ${s.code}`].sort())
  })

  it('two overlapping rates sent at once: one 201, one 409, one audit row (Review Focus 5)', async () => {
    const s = await service(`TEST_SP2_R89_S${RUN}`, await dept())
    const body = { serviceId: s.id, scope: 'base', amountPaise: 50000, validFrom: '2026-01-01' }
    const results = await Promise.all([postRate(req('POST', '/api/tariff/rates', body)), postRate(req('POST', '/api/tariff/rates', { ...body, amountPaise: 60000 }))])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await results.find((r) => r.status === 409)!.json()).toEqual(OVERLAP)
    expect((await actions()).filter((a) => a.startsWith('tariff: added'))).toEqual([`tariff: added base rate for ${s.code}`])
    expect(await getDb().select().from(tariffRates).where(eq(tariffRates.serviceId, s.id))).toHaveLength(1)
  })

  it('revise: back-dated is a plain 400, a valid one closes the day before; ending into the next version is 409', async () => {
    const s = await service(`TEST_SP2_R89_S${RUN}`, await dept())
    const created = await postRate(req('POST', '/api/tariff/rates', { serviceId: s.id, scope: 'base', amountPaise: 50000, validFrom: '2026-01-01' }))
    const rate = await created.json()

    const back = await revise(req('POST', '/', { amountPaise: 55000, effectiveFrom: '2025-12-01' }), ctx(rate.id))
    expect(back.status).toBe(400)
    expect(await back.json()).toEqual({ error: 'New rate must start after the current rate starts' })

    const ok = await revise(req('POST', '/', { amountPaise: 55000, effectiveFrom: '2026-04-01' }), ctx(rate.id))
    expect(ok.status).toBe(200)
    const { closed, created: next } = await ok.json()
    expect(closed.validTo).toBe('2026-03-31')
    expect(next).toMatchObject({ validFrom: '2026-04-01', validTo: null, amountPaise: 55000 })

    const extend = await patchRate(req('PATCH', '/', { validTo: '2026-12-31' }), ctx(rate.id))
    expect(extend.status).toBe(409)
    expect(await extend.json()).toEqual(OVERLAP)

    expect(await actions()).toContain(`tariff: revised rate #${rate.id} for ${s.code} from 2026-04-01`)
    expect((await actions()).filter((a) => a.startsWith('tariff: ended'))).toEqual([])
  })

  it('package items: nested package 400, valid list replaced and audited', async () => {
    const d = await dept()
    const pkg = await service(`TEST_SP2_R89_P${RUN}`, d, 'package')
    const inner = await service(`TEST_SP2_R89_Q${RUN}`, d, 'package')
    const item = await service(`TEST_SP2_R89_S${RUN}`, d)

    const nested = await putItems(req('PUT', '/', { items: [{ serviceId: inner.id, quantity: 1 }] }), ctx(pkg.id))
    expect(nested.status).toBe(400)
    expect(await nested.json()).toEqual({ error: `${inner.code} is a package; packages cannot be nested` })

    const ok = await putItems(req('PUT', '/', { items: [{ serviceId: item.id, quantity: 2 }] }), ctx(pkg.id))
    expect(ok.status).toBe(200)
    const rows = await getDb().select().from(servicePackageItems).where(eq(servicePackageItems.packageServiceId, pkg.id))
    expect(rows.map((r) => [r.itemServiceId, r.quantity])).toEqual([[item.id, 2]])
    expect(await actions()).toContain(`tariff: updated package items for ${pkg.code}`)
  })
})
