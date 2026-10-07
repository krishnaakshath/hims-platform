import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { GET as listRoute, POST as createRoute } from '@/app/api/staff/route'
import { GET as detailRoute, PATCH as patchRoute } from '@/app/api/staff/[id]/route'
import { POST as addCredentialRoute } from '@/app/api/staff/[id]/credentials/route'
import { PATCH as patchCredentialRoute } from '@/app/api/staff/[id]/credentials/[credentialId]/route'
import * as dbClient from '@/db/client'
import { getDb } from '@/db/client'
import { staffMembers, staffCredentials } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'coder' = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdStaffIds: number[] = []
afterEach(async () => {
  sessionRole = 'admin'
  while (createdStaffIds.length > 0) {
    const id = createdStaffIds.pop()!
    await getDb().delete(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
    await getDb().delete(staffMembers).where(eq(staffMembers.id, id))
  }
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

function patchReq(body: unknown) {
  return new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

function params(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) }
}

function credentialParams(id: number | string, credentialId: number | string) {
  return { params: Promise.resolve({ id: String(id), credentialId: String(credentialId) }) }
}

describe('GET /api/staff', () => {
  it.each(['admin', 'pi', 'crc'] as const)('succeeds (200) for role %s', async (role) => {
    sessionRole = role
    const res = await listRoute()
    expect(res.status).toBe(200)
  })

  it.each(['frontdesk', 'pharmacy', 'billing', 'labs', 'coder'] as const)('returns exactly { error: Forbidden } 403 for role %s, before any DB read', async (role) => {
    sessionRole = role
    const dbSpy = vi.spyOn(dbClient, 'getDb')
    const res = await listRoute()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(dbSpy).not.toHaveBeenCalled()
    dbSpy.mockRestore()
  })
})

describe('POST /api/staff', () => {
  it('succeeds (201) as admin, with no userId/providerId in the body', async () => {
    sessionRole = 'admin'
    const res = await createRoute(req({ name: 'Route Test Staff A', department: 'Front Desk', title: 'Receptionist', hireDate: '2024-01-01' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdStaffIds.push(body.id)
    expect(body.userId).toBeNull()
    expect(body.providerId).toBeNull()
  })

  it.each(['pi', 'crc', 'frontdesk'] as const)('returns 403 for role %s', async (role) => {
    sessionRole = role
    const res = await createRoute(req({ name: 'Route Test Staff B', department: 'Front Desk', title: 'Receptionist', hireDate: '2024-01-01' }) as never)
    expect(res.status).toBe(403)
  })

  it('returns 400 for a userId that does not exist', async () => {
    sessionRole = 'admin'
    const res = await createRoute(req({ userId: 999999, name: 'Route Test Staff C', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/staff/[id]', () => {
  it("returns the created staff member's detail including an empty credentials array", async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff D', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const res = await detailRoute(new Request('http://localhost') as never, params(created.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Route Test Staff D')
    expect(body.credentials).toEqual([])
  })

  it.each(['frontdesk', 'pharmacy', 'billing', 'labs', 'coder'] as const)('returns exactly { error: Forbidden } 403 for role %s, before any DB read', async (role) => {
    sessionRole = role
    const dbSpy = vi.spyOn(dbClient, 'getDb')
    const res = await detailRoute(new Request('http://localhost') as never, params(1))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(dbSpy).not.toHaveBeenCalled()
    dbSpy.mockRestore()
  })

  it.each(['pi', 'crc'] as const)('admits role %s (404 for a nonexistent id, not 403)', async (role) => {
    sessionRole = role
    const res = await detailRoute(new Request('http://localhost') as never, params(999999))
    expect(res.status).toBe(404)
  })

  it('returns 404 for a nonexistent id', async () => {
    sessionRole = 'admin'
    const res = await detailRoute(new Request('http://localhost') as never, params(999999))
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/staff/[id]', () => {
  it('lets admin update employment status to terminated, and it persists', async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch A', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const res = await patchRoute(patchReq({ employmentStatus: 'terminated', terminationDate: '2026-09-28' }) as never, params(created.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.employmentStatus).toBe('terminated')
    expect(body.terminationDate).toBe('2026-09-28')

    const detailRes = await detailRoute(new Request('http://localhost') as never, params(created.id))
    const detail = await detailRes.json()
    expect(detail.employmentStatus).toBe('terminated')
  })

  it.each(['pi', 'crc', 'frontdesk'] as const)('returns 403 for role %s', async (role) => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch B', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    sessionRole = role
    const res = await patchRoute(patchReq({ employmentStatus: 'terminated' }) as never, params(created.id))
    expect(res.status).toBe(403)
  })

  it('rejects an unexpected field via .strict()', async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch C', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const res = await patchRoute(patchReq({ name: 'Sneaky Rename' }) as never, params(created.id))
    expect(res.status).toBe(400)
  })

  it('returns 404 for a nonexistent id', async () => {
    sessionRole = 'admin'
    const res = await patchRoute(patchReq({ employmentStatus: 'terminated' }) as never, params(999999))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/staff/[id]/credentials', () => {
  it('succeeds (201) as admin', async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff E', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const res = await addCredentialRoute(req({ credentialType: 'DEA Registration', credentialNumber: 'X999', expiresOn: '2030-01-01' }) as never, params(created.id))
    expect(res.status).toBe(201)
  })

  it.each(['pi', 'crc', 'frontdesk'] as const)('returns 403 for role %s', async (role) => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff F', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    sessionRole = role
    const res = await addCredentialRoute(req({ credentialType: 'DEA Registration' }) as never, params(created.id))
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/staff/[id]/credentials/[credentialId]', () => {
  it("lets admin update a credential's expiresOn, and it persists", async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch Cred A', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const addRes = await addCredentialRoute(req({ credentialType: 'DEA Registration', expiresOn: '2030-01-01' }) as never, params(created.id))
    const credential = await addRes.json()

    const res = await patchCredentialRoute(patchReq({ expiresOn: '2031-06-15' }) as never, credentialParams(created.id, credential.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.expiresOn).toBe('2031-06-15')

    const detailRes = await detailRoute(new Request('http://localhost') as never, params(created.id))
    const detail = await detailRes.json()
    expect(detail.credentials.find((c: { id: number }) => c.id === credential.id).expiresOn).toBe('2031-06-15')
  })

  it.each(['pi', 'crc', 'frontdesk'] as const)('returns 403 for role %s', async (role) => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch Cred B', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const addRes = await addCredentialRoute(req({ credentialType: 'DEA Registration', expiresOn: '2030-01-01' }) as never, params(created.id))
    const credential = await addRes.json()

    sessionRole = role
    const res = await patchCredentialRoute(patchReq({ expiresOn: '2031-06-15' }) as never, credentialParams(created.id, credential.id))
    expect(res.status).toBe(403)
  })

  it('rejects an unexpected field via .strict()', async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch Cred C', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const addRes = await addCredentialRoute(req({ credentialType: 'DEA Registration', expiresOn: '2030-01-01' }) as never, params(created.id))
    const credential = await addRes.json()

    const res = await patchCredentialRoute(patchReq({ staffMemberId: 999999 }) as never, credentialParams(created.id, credential.id))
    expect(res.status).toBe(400)
  })

  it('returns 404 for a nonexistent credential id', async () => {
    sessionRole = 'admin'
    const createRes = await createRoute(req({ name: 'Route Test Staff Patch Cred D', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' }) as never)
    const created = await createRes.json()
    createdStaffIds.push(created.id)

    const res = await patchCredentialRoute(patchReq({ expiresOn: '2031-06-15' }) as never, credentialParams(created.id, 999999))
    expect(res.status).toBe(404)
  })
})
