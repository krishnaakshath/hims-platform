// Wave G P1-05: GET /api/tariff/services/[id]/price-sheet -- the price lookup's rate card.
// Real Postgres; only the session is faked. Fixtures are TWG_-prefixed and deleted by id.
import { describe, it, expect, vi, afterAll, beforeAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, payers, roomCategories, serviceCatalog, tariffRates } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'

let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { GET } from '@/app/api/tariff/services/[id]/price-sheet/route'

const RUN = `${Date.now()}`.slice(-6)
const get = (id: string | number, qs = '') => GET(new NextRequest(`http://localhost/api/tariff/services/${id}/price-sheet${qs}`), { params: Promise.resolve({ id: String(id) }) })

afterEach(() => { sessionRole = 'frontdesk' })

describe('GET /api/tariff/services/[id]/price-sheet gates', () => {
  for (const role of ALL_ROLES.filter((r) => !TARIFF_LOOKUP_ROLES.includes(r))) {
    it(`403s ${role} before reading anything`, async () => {
      sessionRole = role
      const res = await get('not-a-number', '?bogus=1')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })
  }
  it('400s a bad id, an unknown parameter and a bad date', async () => {
    expect((await get('abc')).status).toBe(400)
    expect((await get('0')).status).toBe(400)
    expect((await get('1', '?patientId=RD-0001')).status).toBe(400)
    expect((await get('1', '?onDate=08-10-2026')).status).toBe(400)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('price sheet (DB)', () => {
  const ids = { dept: 0, payer: 0, cat: 0, service: 0, inactive: 0 }

  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: `TWG_D${RUN}`, name: 'Wave G Cardiology', kind: 'clinical' }).returning()
    const [p] = await db.insert(payers).values({ name: 'Wave G Star Health', payerId: `TWG${RUN}` }).returning()
    const [c] = await db.insert(roomCategories).values({ code: `TWG_C${RUN}`, name: 'Wave G Deluxe' }).returning()
    const [s] = await db.insert(serviceCatalog).values({ code: `TWG_S${RUN}`, name: 'Wave G Consult', departmentId: d.id, category: 'consultation', hsnSac: '999311', gstRateBp: 0 }).returning()
    const [x] = await db.insert(serviceCatalog).values({ code: `TWG_X${RUN}`, name: 'Wave G Retired', departmentId: d.id, category: 'consultation', hsnSac: '999311', gstRateBp: 0, isActive: false }).returning()
    Object.assign(ids, { dept: d.id, payer: p.id, cat: c.id, service: s.id, inactive: x.id })
    await db.insert(tariffRates).values([
      { serviceId: s.id, scope: 'base', amountPaise: 50000, validFrom: '2026-01-01', createdByName: 'test' },
      { serviceId: s.id, scope: 'base', roomCategoryId: c.id, amountPaise: 90000, validFrom: '2026-01-01', createdByName: 'test' },
      { serviceId: s.id, scope: 'base', ward: 'icu', amountPaise: 150000, validFrom: '2026-01-01', validTo: '2026-06-30', createdByName: 'test' },
      { serviceId: s.id, scope: 'department', departmentId: d.id, amountPaise: 60000, validFrom: '2026-01-01', createdByName: 'test' },
      { serviceId: s.id, scope: 'payer', payerId: p.id, amountPaise: 45000, validFrom: '2026-01-01', createdByName: 'test' },
    ])
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(tariffRates).where(inArray(tariffRates.serviceId, [ids.service, ids.inactive]))
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [ids.service, ids.inactive]))
    await db.delete(roomCategories).where(inArray(roomCategories.id, [ids.cat]))
    await db.delete(payers).where(inArray(payers.id, [ids.payer]))
    await db.delete(departments).where(inArray(departments.id, [ids.dept]))
  })

  it('lists every rate in force on the date, by scope, in INR', async () => {
    const res = await get(ids.service, '?onDate=2026-10-08')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.service).toMatchObject({ id: ids.service, code: `TWG_S${RUN}`, name: 'Wave G Consult', departmentName: 'Wave G Cardiology' })
    expect(body.onDate).toBe('2026-10-08')
    expect(body.rows.map((r: { formatted: string }) => r.formatted)).toEqual(['₹500.00', '₹900.00', '₹600.00', '₹450.00'])
    expect(body.rows[1].roomCategoryName).toBe('Wave G Deluxe')
    expect(body.payers).toEqual([{ id: ids.payer, name: 'Wave G Star Health' }])
    expect(body.departments).toEqual([{ id: ids.dept, name: 'Wave G Cardiology' }])
  })

  it('includes a ward rate only while it is in force', async () => {
    const body = await (await get(ids.service, '?onDate=2026-03-01')).json()
    expect(body.wards).toEqual(['icu'])
    expect(body.rows.some((r: { ward: string | null }) => r.ward === 'icu')).toBe(true)
  })

  it('404s an unknown or inactive service for a lookup role', async () => {
    expect((await get(2_000_000_000)).status).toBe(404)
    expect((await get(ids.inactive)).status).toBe(404)
  })
})
