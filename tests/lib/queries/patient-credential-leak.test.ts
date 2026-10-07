import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import type { Role } from '@/lib/auth'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { getPatientDetail, listPatientsWithStatus } from '@/lib/queries/patients'
import { getPatientPortalData, verifyPatientPortalCredentials, getPatientMfaState } from '@/lib/queries/patient-portal'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { listWorkbookRows } from '@/lib/queries/workbook'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { searchAll } from '@/lib/queries/search'
import { hashPassword } from '@/lib/password'
import { invalidateCache, patientDetailCacheKey, patientListCacheKey, workbookListCacheKey, patientCollectionsListCacheKey } from '@/lib/cache'

// Runtime half of the credential guard (static half:
// tests/lib/no-credential-leak.test.ts). A patient with a real portal
// password hash and an MFA secret: no read model, route JSON or export
// payload may carry either value, while the login path still verifies.
let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'TEST-SP1 cred', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { GET as listRoute } from '@/app/api/patients/route'
import { GET as detailRoute } from '@/app/api/patients/[anonId]/route'

const RUN = `${Date.now()}`
const PASSWORD = `pw-${RUN}`
const MFA_SECRET = `TEST-MFA-SECRET-${RUN}`
const createdIds: string[] = []
let hash = ''

async function fixture(): Promise<string> {
  const id = `TEST-SP1-cred-${RUN}-${createdIds.length + 1}`
  hash = hashPassword(PASSWORD)
  await getDb().insert(patients).values({
    id, name: `TEST-SP1 Cred ${RUN}`, dob: '1990-01-01', city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
    portalPasswordHash: hash, mfaSecretEncrypted: MFA_SECRET, mfaEnabled: true,
  })
  createdIds.push(id)
  for (const k of [patientDetailCacheKey(id), patientListCacheKey(null), workbookListCacheKey(), patientCollectionsListCacheKey()]) await invalidateCache(k)
  return id
}
const expectClean = (label: string, value: unknown) => {
  const json = JSON.stringify(value)
  expect(json, label).not.toContain(hash)
  expect(json, label).not.toContain(hash.split(':')[0])
  expect(json, label).not.toContain(MFA_SECRET)
  expect(json, label).not.toMatch(/portalPasswordHash|mfaSecretEncrypted/)
}

describe.skipIf(!process.env.DATABASE_URL)('patient credential columns never leave the server (DB)', () => {
  afterEach(async () => {
    sessionRole = 'admin'
    const ids = createdIds.splice(0)
    if (ids.length) await getDb().delete(patients).where(inArray(patients.id, ids))
    for (const id of ids) await invalidateCache(patientDetailCacheKey(id))
    for (const k of [patientListCacheKey(null), workbookListCacheKey(), patientCollectionsListCacheKey()]) await invalidateCache(k)
  })

  it('read models carry portalConfigured/mfaEnabled but never the hash or secret', async () => {
    const id = await fixture()
    const detail = await getPatientDetail(id)
    expect(detail?.portalConfigured).toBe(true)
    expect(detail?.mfaEnabled).toBe(true)
    expectClean('detail', detail)

    const listRow = (await listPatientsWithStatus(null)).find((p) => p.id === id)
    expect(listRow).toBeDefined()
    expectClean('list', listRow)

    const portal = await getPatientPortalData(id)
    expect(portal?.portalConfigured).toBe(true)
    expectClean('portal', portal)

    expectClean('fhir gather', await gatherPatientFhirData(id))
    expectClean('workbook', await listWorkbookRows())
    expectClean('collections', await listPatientCollections())
    expectClean('search', await searchAll(`TEST-SP1 Cred ${RUN}`, { patients: true, trials: false, formTemplates: false, services: false }))
  })

  it('GET /api/patients and GET /api/patients/[anonId] JSON carry neither', async () => {
    const id = await fixture()
    const list = await listRoute(new NextRequest('http://localhost/api/patients'))
    expect(list.status).toBe(200)
    const listText = await list.text()
    expect(listText).toContain(id)
    expectClean('list route', listText)

    const detail = await detailRoute(new NextRequest(`http://localhost/api/patients/${id}`), { params: Promise.resolve({ anonId: id }) })
    expect(detail.status).toBe(200)
    const body = await detail.json()
    expect(body.portalConfigured).toBe(true)
    expectClean('detail route', body)
  })

  it('the login/MFA path still reads the hash and secret server-side', async () => {
    const id = await fixture()
    expect(await verifyPatientPortalCredentials(id, PASSWORD)).toBe(true)
    expect(await verifyPatientPortalCredentials(id, 'wrong')).toBe(false)
    expect(await getPatientMfaState(id)).toEqual({ mfaSecretEncrypted: MFA_SECRET, mfaEnabled: true })
    const [row] = await getDb().select({ h: patients.portalPasswordHash }).from(patients).where(eq(patients.id, id))
    expect(row.h).toBe(hash)
  })
})
