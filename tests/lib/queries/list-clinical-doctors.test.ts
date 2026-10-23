import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, providers } from '@/db/schema'
import { listClinicalDoctors } from '@/lib/queries/providers'

// WS6 T9 review: the clinical-doctor filter is exercised against the real database (the check-in
// page test mocks the loader). A diagnostic-department doctor, an inactive doctor and a doctor in
// an inactive department must all be left out.
const SUFFIX = String(Date.now() % 100000)
const doc = (name: string, departmentId: number, isActive = true) =>
  ({ name, specialty: 'General Medicine', colorTag: 'chart-1', departmentId, isActive })
const names = { clinical: `Dr LCD Clinical ${SUFFIX}`, path: `Dr LCD Path ${SUFFIX}`, inactive: `Dr LCD Inactive ${SUFFIX}`, deptOff: `Dr LCD DeptOff ${SUFFIX}` }
const deptIds: number[] = []
const providerIds: number[] = []

beforeAll(async () => {
  const db = getDb()
  const mk = async (code: string, kind: 'clinical' | 'diagnostic', isActive = true) => {
    const [d] = await db.insert(departments).values({ code: `${code}${SUFFIX}`, name: `LCD ${code} ${SUFFIX}`, kind, isActive }).returning({ id: departments.id })
    deptIds.push(d.id)
    return d.id
  }
  const clinical = await mk('LCC', 'clinical')
  const diagnostic = await mk('LCP', 'diagnostic')
  const off = await mk('LCO', 'clinical', false)
  const rows = await db.insert(providers).values([
    doc(names.clinical, clinical),
    doc(names.path, diagnostic),
    doc(names.inactive, clinical, false),
    doc(names.deptOff, off),
  ]).returning({ id: providers.id })
  providerIds.push(...rows.map((r) => r.id))
})

afterAll(async () => {
  const db = getDb()
  await db.delete(providers).where(inArray(providers.id, providerIds))
  await db.delete(departments).where(inArray(departments.id, deptIds))
})

describe('listClinicalDoctors', () => {
  it('includes an active doctor in an active clinical department and nobody else of the fixtures', async () => {
    const found = (await listClinicalDoctors()).map((d) => d.name).filter((n) => n.includes(`LCD`) && n.endsWith(SUFFIX))
    expect(found).toEqual([names.clinical])
  })
})
