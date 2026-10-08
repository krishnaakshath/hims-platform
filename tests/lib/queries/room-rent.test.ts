import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'

// SP4 Task 9: room rent per IST census day. Stay: admitted 2099-05-01 11:30 IST in a GEN room,
// moved to ICU at 2099-05-02 15:30 IST; `now` is 2099-05-04 11:30 IST, so 05-01..05-03 have ended.
const NOW = new Date('2099-05-04T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('room-rent posting (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP4-${RUN}`
  const PID2 = `TEST-SP4-${RUN}-B`
  const CODE = `TSP4${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const session: Session = { role: 'crc', name: `TEST-SP4-${RUN}`, userId: null }
  const fx = { departmentId: 0, serviceId: 0, cats: [] as number[], rooms: [] as number[], rates: [] as number[], admissions: [] as number[], transfers: [] as number[],
    gen: 0, icu: 0, noRate: 0, admissionId: 0, admission2Id: 0, roomlessId: 0 }
  let savedSettings: Record<string, unknown> | null = null

  const m = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    rr: await import('@/lib/queries/room-rent'),
  })

  beforeAll(async () => {
    const { getDb, departments, providers, roomCategories, rooms, serviceCatalog, tariffRates, patients, admissions, admissionTransfers, billingSettings, eq } = await m()
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    const [prov] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    const [dep] = await db.insert(departments).values({ code: CODE, name: `Test SP4 ${RUN}` }).returning()
    fx.departmentId = dep.id
    const [svc] = await db.insert(serviceCatalog).values({ code: `${CODE}RR`, name: 'Test room rent', departmentId: dep.id, category: 'room_rent', hsnSac: '999311' }).returning()
    fx.serviceId = svc.id
    await db.update(billingSettings).set({ roomRentServiceId: svc.id }).where(eq(billingSettings.id, 1))
    const cat = async (suffix: string) => { const [c] = await db.insert(roomCategories).values({ code: `${CODE}${suffix}`, name: `Test ${suffix}` }).returning(); fx.cats.push(c.id); return c.id }
    const genCat = await cat('G'); const icuCat = await cat('I'); const nrCat = await cat('N')
    const room = async (categoryId: number, n: string) => { const [r] = await db.insert(rooms).values({ ward: 'Test SP4 Ward', roomNumber: `${CODE}${n}`, bedNumber: '1', roomCategoryId: categoryId }).returning(); fx.rooms.push(r.id); return r.id }
    fx.gen = await room(genCat, 'G'); fx.icu = await room(icuCat, 'I'); fx.noRate = await room(nrCat, 'N')
    const rate = async (roomCategoryId: number, amountPaise: number) =>
      fx.rates.push((await db.insert(tariffRates).values({ serviceId: svc.id, scope: 'base', roomCategoryId, amountPaise, validFrom: '2099-01-01', createdByName: 'TEST-SP4' }).returning())[0].id)
    await rate(genCat, 200000); await rate(icuCat, 900000)
    await db.insert(patients).values([{ id: PID, name: 'Test SP4 Room', dob: '1990-01-01' }, { id: PID2, name: 'Test SP4 Room B', dob: '1990-01-01' }])
    const admit = async (patientId: string, currentRoomId: number | null) => {
      const [a] = await db.insert(admissions).values({ patientId, attendingProviderId: prov.id, currentRoomId, admittedAt: new Date('2099-05-01T06:00:00Z') }).returning()
      fx.admissions.push(a.id); return a.id
    }
    fx.admissionId = await admit(PID, fx.icu)
    fx.admission2Id = await admit(PID2, fx.gen)
    fx.roomlessId = await admit(PID2, null)
    const move = async (admissionId: number, fromRoomId: number, toRoomId: number) =>
      fx.transfers.push((await db.insert(admissionTransfers).values({ admissionId, fromRoomId, toRoomId, reason: 'Test', transferredByName: 'TEST-SP4', transferredAt: new Date('2099-05-02T10:00:00Z') }).returning())[0].id)
    await move(fx.admissionId, fx.gen, fx.icu)
    await move(fx.admission2Id, fx.noRate, fx.gen)
  })

  afterEach(async () => {
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    await purgeBillingFixtures([PID, PID2])
  })

  afterAll(async () => {
    const { getDb, departments, roomCategories, rooms, serviceCatalog, tariffRates, patients, admissions, admissionTransfers, billingSettings, auditLog, eq, inArray } = await m()
    const { purgeBillingFixtures } = await import('../../db/billing-fixtures')
    const db = getDb()
    await purgeBillingFixtures([PID, PID2])
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db.delete(admissionTransfers).where(inArray(admissionTransfers.id, fx.transfers))
    await db.delete(admissions).where(inArray(admissions.id, fx.admissions))
    await db.delete(patients).where(inArray(patients.id, [PID, PID2]))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rates))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, fx.serviceId))
    await db.delete(rooms).where(inArray(rooms.id, fx.rooms))
    await db.delete(roomCategories).where(inArray(roomCategories.id, fx.cats))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
    await db.delete(auditLog).where(inArray(auditLog.patientId, [PID, PID2]))
  })

  async function lines(admissionId: number) {
    const { getDb, chargeLines, eq, asc } = await m()
    return getDb().select().from(chargeLines).where(eq(chargeLines.admissionId, admissionId)).orderBy(asc(chargeLines.serviceDate), asc(chargeLines.id))
  }

  it('posts one line per census day with the day room category price', async () => {
    const { rr } = await m()
    expect(await rr.postRoomRent(fx.admissionId, session, { now: NOW })).toEqual({ ok: true, posted: 3, skipped: [] })
    const rows = await lines(fx.admissionId)
    expect(rows.map((r) => [r.serviceDate, r.unitPricePaise, r.taxablePaise])).toEqual([
      ['2099-05-01', 200000, 200000], ['2099-05-02', 900000, 900000], ['2099-05-03', 900000, 900000],
    ])
    expect(rows[0]).toMatchObject({ source: 'room_rent', status: 'captured', quantity: 1, serviceId: fx.serviceId, itemCode: `${CODE}RR`,
      serviceCategory: 'room_rent', priceSource: 'base', patientId: PID, createdByName: session.name })
  })

  it('is idempotent: a second post adds nothing', async () => {
    const { rr } = await m()
    await rr.postRoomRent(fx.admissionId, session, { now: NOW })
    expect(await rr.postRoomRent(fx.admissionId, session, { now: NOW })).toEqual({ ok: true, posted: 0, skipped: [] })
    expect(await lines(fx.admissionId)).toHaveLength(3)
  })

  it('concurrent posts never duplicate a day', async () => {
    const { rr } = await m()
    const [a, b] = await Promise.all([rr.postRoomRent(fx.admissionId, session, { now: NOW }), rr.postRoomRent(fx.admissionId, session, { now: NOW })])
    expect((a.ok ? a.posted : 0) + (b.ok ? b.posted : 0)).toBe(3)
    expect(await lines(fx.admissionId)).toHaveLength(3)
  })

  it('honours throughDate', async () => {
    const { rr } = await m()
    expect(await rr.postRoomRent(fx.admissionId, session, { now: NOW, throughDate: '2099-05-01' })).toEqual({ ok: true, posted: 1, skipped: [] })
  })

  it('reports a no_rate day and posts the rest', async () => {
    const { rr } = await m()
    expect(await rr.postRoomRent(fx.admission2Id, session, { now: NOW })).toEqual({ ok: true, posted: 2, skipped: [{ date: '2099-05-01', reason: 'no_rate' }] })
    expect((await lines(fx.admission2Id)).map((r) => r.serviceDate)).toEqual(['2099-05-02', '2099-05-03'])
  })

  it('reports no_room days for a stay without a bed', async () => {
    const { rr } = await m()
    const r = await rr.postRoomRent(fx.roomlessId, session, { now: NOW })
    expect(r).toEqual({ ok: true, posted: 0, skipped: ['2099-05-01', '2099-05-02', '2099-05-03'].map((date) => ({ date, reason: 'no_room' })) })
  })

  it('a voided day is re-posted on the next run', async () => {
    const { rr, getDb, chargeLines, eq } = await m()
    await rr.postRoomRent(fx.admissionId, session, { now: NOW })
    const [first] = await lines(fx.admissionId)
    await getDb().update(chargeLines).set({ status: 'void', voidReason: 'Wrong bed', voidedAt: new Date(), voidedByName: 'TEST-SP4' }).where(eq(chargeLines.id, first.id))
    expect(await rr.postRoomRent(fx.admissionId, session, { now: NOW })).toEqual({ ok: true, posted: 1, skipped: [] })
    expect((await lines(fx.admissionId)).filter((r) => r.status !== 'void')).toHaveLength(3)
  })

  it('audits ids and counts only', async () => {
    const { rr, getDb, auditLog, eq } = await m()
    await rr.postRoomRent(fx.admission2Id, session, { now: NOW })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.patientId, PID2))
    expect(rows.map((r) => `${r.action}|${r.details}`)).toContain(`billing: posted room rent|admission=${fx.admission2Id} days=2 skipped=1`)
  })

  it('not_found and service_not_configured', async () => {
    const { rr, getDb, billingSettings, eq } = await m()
    expect(await rr.postRoomRent(2_147_483_000, session, { now: NOW })).toEqual({ ok: false, error: 'not_found' })
    await getDb().update(billingSettings).set({ roomRentServiceId: null }).where(eq(billingSettings.id, 1))
    try {
      expect(await rr.postRoomRent(fx.admissionId, session, { now: NOW })).toEqual({ ok: false, error: 'service_not_configured' })
    } finally {
      await getDb().update(billingSettings).set({ roomRentServiceId: fx.serviceId }).where(eq(billingSettings.id, 1))
    }
  })
})
