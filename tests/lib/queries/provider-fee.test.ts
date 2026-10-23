import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, providers, serviceCatalog, tariffRates } from '@/db/schema'
import { consultationFeePaise, listAllProvidersWithTariffFee } from '@/lib/queries/providers'
import { reviseRate } from '@/lib/queries/tariff'

const RUN = `${Date.now()}`
let deptId = 0, emptyDeptId = 0, providerId = 0, noDeptProviderId = 0, noRateProviderId = 0, serviceId = 0, rateId = 0

describe.skipIf(!process.env.DATABASE_URL)('consultationFeePaise (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: `TF${RUN.slice(-9)}`, name: 'TEST_T10 fee dept', kind: 'clinical' }).returning()
    const [e] = await db.insert(departments).values({ code: `TE${RUN.slice(-9)}`, name: 'TEST_T10 empty dept', kind: 'clinical' }).returning()
    deptId = d.id; emptyDeptId = e.id
    const mk = async (name: string, departmentId: number | null, fee: number | null) =>
      (await db.insert(providers).values({ name: `TEST_T10 ${name} ${RUN}`, specialty: 'Medicine', colorTag: 'chart-1', departmentId, consultationFeePaise: fee }).returning())[0].id
    providerId = await mk('A', deptId, 99999) // stale stored fee must be ignored
    noDeptProviderId = await mk('B', null, 12345)
    noRateProviderId = await mk('C', emptyDeptId, 12345)
    const [s] = await db.insert(serviceCatalog).values({ code: `TF${RUN.slice(-8)}`, name: 'TEST_T10 consult', departmentId: deptId, category: 'consultation', hsnSac: '999312' }).returning()
    serviceId = s.id
    const [r] = await db.insert(tariffRates).values({ serviceId, scope: 'base', amountPaise: 60000, validFrom: '2020-01-01', createdByName: 'TEST_T10' }).returning()
    rateId = r.id
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(providers).where(eq(providers.departmentId, deptId))
    await db.delete(providers).where(eq(providers.id, noDeptProviderId))
    await db.delete(providers).where(eq(providers.id, noRateProviderId))
    await db.delete(tariffRates).where(eq(tariffRates.serviceId, serviceId))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, serviceId))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(departments).where(eq(departments.id, emptyDeptId))
  })

  it('equals the department consultation base rate, not the stored column', async () => {
    expect(await consultationFeePaise(providerId)).toBe(60000)
    const row = (await listAllProvidersWithTariffFee()).find((p) => p.id === providerId)
    expect(row?.tariffFeePaise).toBe(60000)
  })

  it('is null without a department or without a consultation rate', async () => {
    expect(await consultationFeePaise(noDeptProviderId)).toBeNull()
    expect(await consultationFeePaise(noRateProviderId)).toBeNull()
    expect(await consultationFeePaise(-1)).toBeNull()
  })

  it('follows a revised rate', async () => {
    const out = await reviseRate(rateId, { amountPaise: 75000, effectiveFrom: '2020-06-01' }, 'TEST_T10')
    expect(out).toBeTruthy()
    expect(await consultationFeePaise(providerId)).toBe(75000)
  })
})
