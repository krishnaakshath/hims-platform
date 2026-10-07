// POST /api/tariff/import against the real query layer, real audit and real Postgres (exclusion and
// unique constraints included). Only the session is faked; getImportLookups is the real function
// unless a test makes it return a stale snapshot to force a commit-time conflict. Fixtures are
// TEST_SP2_-prefixed and deleted by id; audit rows by this run's unique probe user name.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, departments, serviceCatalog, tariffRates } from '@/db/schema'
import { RATE_CSV_HEADERS, SERVICE_CSV_HEADERS } from '@/lib/tariff/import'

const RUN = `${Date.now()}`.slice(-6)
const PROBE_USER = `TEST_SP2_I11-${Date.now()}`

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'billing', name: PROBE_USER, userId: null })) }
})
vi.mock('@/lib/queries/tariff', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/tariff')>('@/lib/queries/tariff')
  return { ...actual, getImportLookups: vi.fn(actual.getImportLookups) }
})

import { getImportLookups } from '@/lib/queries/tariff'
import { POST as postImport } from '@/app/api/tariff/import/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/tariff/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const RATE_HEADER = RATE_CSV_HEADERS.join(',')
const SERVICE_HEADER = SERVICE_CSV_HEADERS.join(',')
const CONFLICT = { error: 'Import conflicts with existing data; nothing was applied' }

describe.skipIf(!process.env.DATABASE_URL)('tariff import route (DB)', () => {
  const ids = { services: [] as number[], depts: [] as number[] }
  const codes: string[] = [] // services the import itself may create; resolved to ids for cleanup

  afterEach(async () => {
    const db = getDb()
    if (codes.length) {
      const created = await db.select({ id: serviceCatalog.id }).from(serviceCatalog).where(inArray(serviceCatalog.code, codes.splice(0)))
      ids.services.push(...created.map((c) => c.id).filter((id) => !ids.services.includes(id)))
    }
    const services = ids.services.splice(0)
    if (services.length) {
      await db.delete(tariffRates).where(inArray(tariffRates.serviceId, services))
      await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, services))
    }
    if (ids.depts.length) await db.delete(departments).where(inArray(departments.id, ids.depts.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    vi.mocked(getImportLookups).mockClear()
  })

  const actions = async () => (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).map((a) => a.action)
  const ratesOf = (serviceId: number) => getDb().select().from(tariffRates).where(eq(tariffRates.serviceId, serviceId))

  async function fixtures() {
    const db = getDb()
    const deptCode = `TEST_SP2_D${RUN}`
    const [d] = await db.insert(departments).values({ code: deptCode, name: 'Test SP2 I11 Dept', kind: 'clinical' }).returning()
    ids.depts.push(d.id)
    const code = `TEST_SP2_I_S${RUN}`
    const [s] = await db.insert(serviceCatalog).values({ code, name: 'Test import service', departmentId: d.id, category: 'procedure', hsnSac: '999311', gstRateBp: 1800 }).returning()
    ids.services.push(s.id)
    return { deptCode, deptId: d.id, service: s }
  }

  /** Lookups as they were before `mutate` ran: the snapshot a concurrent writer would invalidate. */
  async function staleLookupsAround(mutate: () => Promise<void>) {
    const { getImportLookups: real } = await vi.importActual<typeof import('@/lib/queries/tariff')>('@/lib/queries/tariff')
    const snapshot = await real()
    await mutate()
    vi.mocked(getImportLookups).mockResolvedValueOnce(snapshot)
  }

  it('a dry run validates against the DB and writes nothing', async () => {
    const { service } = await fixtures()
    const csv = `${RATE_HEADER}\n${service.code},base,,,,,500,2026-10-07,\n`
    const res = await postImport(post({ kind: 'rates', csv, commit: false }))
    expect(await res.json()).toEqual({ kind: 'rates', rowCount: 1, issues: [], committed: false })
    expect(await ratesOf(service.id)).toHaveLength(0)
    expect(await actions()).toEqual([])
  })

  it('a commit applies every row in one transaction with exactly one audit row', async () => {
    const { service, deptCode } = await fixtures()
    const csv = `﻿${RATE_HEADER}\r\n${service.code},base,,,,,500,2026-01-01,2026-06-30\r\n`
      + `${service.code},department,${deptCode},,,"  ICU   Ward ","1,250.00",2026-01-01,\r\n\r\n`
    const res = await postImport(post({ kind: 'rates', csv, commit: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: 'rates', rowCount: 2, issues: [], committed: true, applied: 2 })
    const rows = (await ratesOf(service.id)).sort((a, b) => a.amountPaise - b.amountPaise)
    expect(rows.map((r) => [r.scope, r.ward, r.amountPaise, r.validFrom, r.validTo, r.createdByName])).toEqual([
      ['base', null, 50_000, '2026-01-01', '2026-06-30', PROBE_USER],
      ['department', 'icu ward', 125_000, '2026-01-01', null, PROBE_USER],
    ])
    expect(await actions()).toEqual(['tariff: imported 2 rates'])
  })

  it('a commit-time exclusion violation is a 409 and rolls back every row and the audit row', async () => {
    const { service } = await fixtures()
    await staleLookupsAround(async () => {
      await getDb().insert(tariffRates).values({ serviceId: service.id, scope: 'base', amountPaise: 1, validFrom: '2026-03-01', createdByName: PROBE_USER })
    })
    // Line 2 is fine on its own; line 3 overlaps the rate added after the lookups were read.
    const csv = `${RATE_HEADER}\n${service.code},base,,,,,500,2025-01-01,2025-12-31\n${service.code},base,,,,,600,2026-01-01,\n`
    const res = await postImport(post({ kind: 'rates', csv, commit: true }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(CONFLICT)
    expect((await ratesOf(service.id)).map((r) => r.amountPaise)).toEqual([1])
    expect(await actions()).toEqual([])
  })

  it('services: inserts and updates together; a commit-time unique violation rolls back the whole file', async () => {
    const { service, deptCode } = await fixtures()
    const fresh = `TEST_SP2_I_N${RUN}`
    codes.push(fresh)
    const ok = `${SERVICE_HEADER}\n${fresh},New imported,${deptCode},procedure,999311,18,yes\n${service.code},Renamed by import,${deptCode},procedure,999311,12,no\n`
    const res = await postImport(post({ kind: 'services', csv: ok, commit: true }))
    expect(await res.json()).toEqual({ kind: 'services', rowCount: 2, issues: [], committed: true, applied: 2 })
    const [renamed] = await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, service.id))
    expect([renamed.name, renamed.gstRateBp, renamed.isActive]).toEqual(['Renamed by import', 1200, false])
    expect(await actions()).toEqual(['tariff: imported 2 services'])

    // A second file: line 2 updates the existing service, line 3 adds a code that someone else
    // created after this import was validated.
    const racer = `TEST_SP2_I_R${RUN}`
    codes.push(racer)
    await staleLookupsAround(async () => {
      const [r] = await getDb().insert(serviceCatalog).values({ code: racer, name: 'Racer', departmentId: service.departmentId, category: 'procedure', hsnSac: '999311', gstRateBp: 0 }).returning()
      ids.services.push(r.id)
    })
    const clash = `${SERVICE_HEADER}\n${service.code},Should not stick,${deptCode},procedure,999311,18,yes\n${racer},Clash,${deptCode},procedure,999311,18,yes\n`
    const res2 = await postImport(post({ kind: 'services', csv: clash, commit: true }))
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual(CONFLICT)
    const [after] = await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, service.id))
    expect(after.name).toBe('Renamed by import')
    expect(await actions()).toEqual(['tariff: imported 2 services'])
  })
})
