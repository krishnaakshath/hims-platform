// SP7 test world for pre-auth DB tests: a base RCM patient (tests/db/rcm-fixtures.ts) plus a
// department, two services (one with a base rate, one without) and a fictional ICD-10 and
// ICD-10-PCS code set. Clean up with destroyPreauthWorld.
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { codeSystems, codes, departments, serviceCatalog, tariffRates } from '@/db/schema'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'

export interface PreauthWorld extends RcmBase { run: string; departmentId: number; pricedServiceId: number; unpricedServiceId: number; unpricedCode: string; dxId: number; pxId: number; systemIds: number[] }

export async function makePreauthWorld(run: string, suffix: string): Promise<PreauthWorld> {
  const db = getDb()
  const base = await makeRcmBase(run, suffix)
  const code = `TSP7${run}${suffix}`
  const [dep] = await db.insert(departments).values({ code, name: `Test SP7 ${run}${suffix}` }).returning()
  const svc = async (s: string) => (await db.insert(serviceCatalog).values({ code: `${code}${s}`, name: `Test SP7 ${s}`, departmentId: dep.id, category: 'procedure', hsnSac: '999312', gstRateBp: 0 }).returning())[0].id
  const priced = await svc('P')
  const unpriced = await svc('N')
  await db.insert(tariffRates).values({ serviceId: priced, scope: 'base', amountPaise: 50_000_00, validFrom: '2026-01-01', createdByName: 'TEST-SP7' })
  const [dxSys] = await db.insert(codeSystems).values({ kind: 'icd10', version: `TEST-SP7-${run}${suffix}-dx`, name: 'TEST fictional', licenceNote: 'Test', sourceFileName: 't.csv', sourceSha256: 'x', codeCount: 1, importedByName: 'TEST-SP7' }).returning()
  const [pxSys] = await db.insert(codeSystems).values({ kind: 'icd10pcs', version: `TEST-SP7-${run}${suffix}-px`, name: 'TEST fictional', licenceNote: 'Test', sourceFileName: 't.csv', sourceSha256: 'x', codeCount: 1, importedByName: 'TEST-SP7' }).returning()
  const [dx] = await db.insert(codes).values({ codeSystemId: dxSys.id, code: 'U1Z.1', display: 'TEST fictional diagnosis' }).returning()
  const [px] = await db.insert(codes).values({ codeSystemId: pxSys.id, code: '0DTJ4ZZ', display: 'TEST fictional procedure' }).returning()
  return { ...base, run, departmentId: dep.id, pricedServiceId: priced, unpricedServiceId: unpriced, unpricedCode: `${code}N`, dxId: dx.id, pxId: px.id, systemIds: [dxSys.id, pxSys.id] }
}

export async function destroyPreauthWorld(w: PreauthWorld): Promise<void> {
  const db = getDb()
  await purgeRcmFixtures([w.patientId], [w.insurerId, w.tpaId])
  await deleteRcmBasePatient(w.patientId)
  await db.delete(tariffRates).where(inArray(tariffRates.serviceId, [w.pricedServiceId, w.unpricedServiceId]))
  await db.delete(serviceCatalog).where(inArray(serviceCatalog.id, [w.pricedServiceId, w.unpricedServiceId]))
  await db.delete(departments).where(eq(departments.id, w.departmentId))
  await db.delete(codes).where(inArray(codes.codeSystemId, w.systemIds))
  await db.delete(codeSystems).where(inArray(codeSystems.id, w.systemIds))
}
