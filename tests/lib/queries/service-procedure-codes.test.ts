// SP6 Task 14: the service <-> procedure-code map against the real local Postgres. Fixtures: a TEST
// department, a TEST package / procedure / consultation service, and a current TEST hbp version
// (non-sample, licence note) with one inactive and one category-heading code. Everything is
// deleted by id afterwards; audit rows by this run's unique probe user name.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, codeSystems, codes, departments, serviceCatalog, serviceProcedureCodes } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  listMappableServices, listServiceProcedureCodes, replaceServiceProcedureCodes,
} from '@/lib/queries/service-procedure-codes'

const RUN = `${Date.now()}`.slice(-8)
const PROBE_USER = `TEST-SP6-T14-${Date.now()}`
const CODER: Session = { role: 'coder', name: PROBE_USER, userId: null }

let deptId = 0
let packageId = 0
let procedureId = 0
let consultId = 0
const systemIds: number[] = []

describe.skipIf(!process.env.DATABASE_URL)('service procedure codes (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    // Only one current version per kind may exist; this run needs a current hbp version.
    const existing = await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'hbp'), eq(codeSystems.isCurrent, true)))
    expect(existing, 'a current hbp version already exists in this database').toEqual([])
    const [d] = await db.insert(departments).values({ code: `TS6S${RUN}`.slice(0, 12), name: 'TEST_SP6 Service codes dept', kind: 'clinical' }).returning()
    deptId = d.id
    const svc = async (code: string, category: 'package' | 'procedure' | 'consultation') => {
      const [s] = await db.insert(serviceCatalog).values({
        code: `T${RUN}${code}`.slice(0, 16), name: `TEST_SP6 ${category} ${RUN}`, departmentId: deptId, category, hsnSac: '999311',
      }).returning()
      return s.id
    }
    packageId = await svc('PK', 'package')
    procedureId = await svc('PR', 'procedure')
    consultId = await svc('CN', 'consultation')
    const [hbp] = await db.insert(codeSystems).values({
      kind: 'hbp', version: `TEST-SP6-${RUN}-hbp`, name: 'TEST fictional HBP', isCurrent: true, licenceNote: 'Test licence',
      sourceFileName: 'test.csv', sourceSha256: 'x', codeCount: 4, importedByName: PROBE_USER,
    }).returning()
    systemIds.push(hbp.id)
    await db.insert(codes).values([
      { codeSystemId: hbp.id, code: 'SMP001A', display: 'TEST fictional package A' },
      { codeSystemId: hbp.id, code: 'SMP002A', display: 'TEST fictional package B' },
      { codeSystemId: hbp.id, code: 'SMP003A', display: 'TEST fictional retired', active: false },
      { codeSystemId: hbp.id, code: 'SMP0', display: 'TEST fictional heading', selectable: false },
    ])
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    const db = getDb()
    await db.delete(serviceProcedureCodes).where(inArray(serviceProcedureCodes.serviceId, [packageId, procedureId, consultId]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(serviceProcedureCodes).where(inArray(serviceProcedureCodes.serviceId, [packageId, procedureId, consultId]))
    if (systemIds.length) {
      await db.delete(codes).where(inArray(codes.codeSystemId, systemIds))
      await db.delete(codeSystems).where(inArray(codeSystems.id, systemIds))
    }
    await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [packageId, procedureId, consultId]))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  const rowsOf = async (serviceId: number) =>
    getDb().select().from(serviceProcedureCodes).where(eq(serviceProcedureCodes.serviceId, serviceId))

  it('replaces the map atomically and refuses unknown codes', async () => {
    expect(await replaceServiceProcedureCodes(packageId, [{ kind: 'hbp', code: 'smp001a', isPrimary: true }], CODER)).toEqual({ ok: true })
    const before = await rowsOf(packageId)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ codeSystemKind: 'hbp', code: 'SMP001A', isPrimary: true, createdByName: PROBE_USER })

    const r = await replaceServiceProcedureCodes(packageId, [{ kind: 'hbp', code: 'SMP002A', isPrimary: true }, { kind: 'hbp', code: 'SMP999Z', isPrimary: false }], CODER)
    expect(r).toEqual({ ok: false, error: 'code_not_found', problems: ['SMP999Z is not an active PM-JAY HBP package code in the current version'] })
    expect(await rowsOf(packageId)).toEqual(before)

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.map((a) => [a.action, a.patientId, a.details])).toEqual([['coding: replaced service procedure codes', null, `service=${packageId} codes=1`]])
  })

  it('refuses inactive codes, category headings and badly formed codes without echoing the last', async () => {
    const r = await replaceServiceProcedureCodes(packageId, [
      { kind: 'hbp', code: 'SMP003A', isPrimary: false }, { kind: 'hbp', code: 'SMP0', isPrimary: false }, { kind: 'hbp', code: 'bad;code', isPrimary: false },
    ], CODER)
    expect(r).toEqual({
      ok: false, error: 'code_not_found', problems: [
        'SMP003A is not an active PM-JAY HBP package code in the current version',
        'SMP0 is a category heading and cannot be mapped',
        'A PM-JAY HBP package code is not in the expected format',
      ],
    })
    expect(await rowsOf(packageId)).toEqual([])
  })

  it('refuses kinds that do not fit the category, a consultation, and an unknown service', async () => {
    expect(await replaceServiceProcedureCodes(packageId, [{ kind: 'icd10pcs', code: 'ZZ00000', isPrimary: false }], CODER))
      .toEqual({ ok: false, error: 'incompatible', problems: ['ICD-10-PCS codes do not fit a package service'] })
    expect(await replaceServiceProcedureCodes(consultId, [{ kind: 'hbp', code: 'SMP001A', isPrimary: false }], CODER))
      .toEqual({ ok: false, error: 'incompatible', problems: ['This kind of service cannot carry procedure codes'] })
    expect(await replaceServiceProcedureCodes(2147483000, [], CODER)).toEqual({ ok: false, error: 'service_not_found' })
    // A code that is not in the current version (or no version of the kind is loaded): not found, named.
    // ZZ09999 is in no code set, so this holds whether or not the demo seed loaded the SAMPLE ICD-10-PCS set.
    expect(await replaceServiceProcedureCodes(procedureId, [{ kind: 'icd10pcs', code: 'ZZ09999', isPrimary: false }], CODER))
      .toEqual({ ok: false, error: 'code_not_found', problems: ['ZZ09999 is not an active ICD-10-PCS code in the current version'] })
    expect(await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).toEqual([])
  })

  it('refuses a sample code set in production', async () => {
    await getDb().update(codeSystems).set({ isSample: true }).where(eq(codeSystems.id, systemIds[0]))
    try {
      vi.stubEnv('VERCEL_ENV', 'production')
      expect(await replaceServiceProcedureCodes(packageId, [{ kind: 'hbp', code: 'SMP001A', isPrimary: false }], CODER))
        .toEqual({ ok: false, error: 'code_not_found', problems: ['SMP001A is from a sample (fictional) code set'] })
      vi.unstubAllEnvs()
      expect(await replaceServiceProcedureCodes(packageId, [{ kind: 'hbp', code: 'SMP001A', isPrimary: false }], CODER)).toEqual({ ok: true })
    } finally {
      await getDb().update(codeSystems).set({ isSample: false }).where(eq(codeSystems.id, systemIds[0]))
    }
  })

  it('clears with an empty list and lists maps per service, primary first, with the current display', async () => {
    await replaceServiceProcedureCodes(procedureId, [
      { kind: 'hbp', code: 'SMP002A', isPrimary: false }, { kind: 'hbp', code: 'SMP001A', isPrimary: true },
    ], CODER)
    await replaceServiceProcedureCodes(packageId, [{ kind: 'hbp', code: 'SMP001A', isPrimary: false }], CODER)
    const map = await listServiceProcedureCodes([procedureId, packageId, consultId])
    expect(map.get(procedureId)!.map((r) => [r.code, r.isPrimary, r.display])).toEqual([
      ['SMP001A', true, 'TEST fictional package A'], ['SMP002A', false, 'TEST fictional package B'],
    ])
    expect(map.get(procedureId)![0]).toEqual({ serviceId: procedureId, kind: 'hbp', code: 'SMP001A', isPrimary: true, display: 'TEST fictional package A', isSample: false })
    expect(map.get(packageId)!.map((r) => r.code)).toEqual(['SMP001A'])
    expect(map.has(consultId)).toBe(false)
    expect(await listServiceProcedureCodes([])).toEqual(new Map())

    expect(await replaceServiceProcedureCodes(procedureId, [], CODER)).toEqual({ ok: true })
    expect(await rowsOf(procedureId)).toEqual([])
  })

  it('lists only mappable categories, searchable by code or name', async () => {
    const all = await listMappableServices(`TEST_SP6 package ${RUN}`)
    expect(all.map((s) => s.id)).toEqual([packageId])
    expect(all[0]).toEqual({ id: packageId, code: `T${RUN}PK`.slice(0, 16), name: `TEST_SP6 package ${RUN}`, category: 'package', isActive: true })
    const byCode = await listMappableServices(`t${RUN}`)
    expect(byCode.map((s) => s.id).sort()).toEqual([packageId, procedureId].sort())
    expect(byCode.map((s) => s.id)).not.toContain(consultId)
  })
})
