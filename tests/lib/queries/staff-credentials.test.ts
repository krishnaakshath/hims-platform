import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, staffCredentials } from '@/db/schema'
import { addCredential, listExpiringOrExpiredCredentials, updateCredential } from '@/lib/queries/staff-credentials'

const createdStaffIds: number[] = []
afterEach(async () => {
  while (createdStaffIds.length > 0) {
    const id = createdStaffIds.pop()!
    await getDb().delete(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
    await getDb().delete(staffMembers).where(eq(staffMembers.id, id))
  }
})

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function makeStaff(name: string, employmentStatus?: 'active' | 'on_leave' | 'terminated') {
  const [s] = await getDb().insert(staffMembers).values({ name, department: 'Clinical', title: 'Test', hireDate: '2024-01-01', ...(employmentStatus ? { employmentStatus } : {}) }).returning()
  createdStaffIds.push(s.id)
  return s
}

describe('staff credentials queries', () => {
  it('adds a credential to a staff member', async () => {
    const staff = await makeStaff('Boundary Test Staff 1')
    const result = await addCredential({ staffMemberId: staff.id, credentialType: 'DEA Registration', credentialNumber: 'X123', expiresOn: daysFromNow(100) })
    expect(result.ok).toBe(true)
  })

  it('a credential expiring in exactly 60 days appears in the expiring-soon list, one expiring in 61 days does not', async () => {
    const staffAt60 = await makeStaff('Boundary Test Staff 60')
    const staffAt61 = await makeStaff('Boundary Test Staff 61')
    await addCredential({ staffMemberId: staffAt60.id, credentialType: 'State License', credentialNumber: null, expiresOn: daysFromNow(60) })
    await addCredential({ staffMemberId: staffAt61.id, credentialType: 'State License', credentialNumber: null, expiresOn: daysFromNow(61) })

    const results = await listExpiringOrExpiredCredentials()
    expect(results.some((r) => r.staffMemberId === staffAt60.id)).toBe(true)
    expect(results.some((r) => r.staffMemberId === staffAt61.id)).toBe(false)
  })

  it('an already-expired credential gets its own status, distinct from expiring-soon', async () => {
    const expiredStaff = await makeStaff('Boundary Test Staff Expired')
    const soonStaff = await makeStaff('Boundary Test Staff Soon')
    await addCredential({ staffMemberId: expiredStaff.id, credentialType: 'DEA Registration', credentialNumber: null, expiresOn: daysFromNow(-5) })
    await addCredential({ staffMemberId: soonStaff.id, credentialType: 'DEA Registration', credentialNumber: null, expiresOn: daysFromNow(10) })

    const results = await listExpiringOrExpiredCredentials()
    const expiredRow = results.find((r) => r.staffMemberId === expiredStaff.id)
    const soonRow = results.find((r) => r.staffMemberId === soonStaff.id)
    expect(expiredRow?.status).toBe('expired')
    expect(soonRow?.status).toBe('expiring_soon')
  })

  it('excludes a terminated staff member\'s expiring/expired credential, but keeps an on_leave staff member\'s', async () => {
    const terminatedStaff = await makeStaff('Boundary Test Staff Terminated', 'terminated')
    const onLeaveStaff = await makeStaff('Boundary Test Staff On Leave', 'on_leave')
    await addCredential({ staffMemberId: terminatedStaff.id, credentialType: 'DEA Registration', credentialNumber: null, expiresOn: daysFromNow(-5) })
    await addCredential({ staffMemberId: onLeaveStaff.id, credentialType: 'DEA Registration', credentialNumber: null, expiresOn: daysFromNow(10) })

    const results = await listExpiringOrExpiredCredentials()
    expect(results.some((r) => r.staffMemberId === terminatedStaff.id)).toBe(false)
    expect(results.some((r) => r.staffMemberId === onLeaveStaff.id)).toBe(true)
  })

  it('updates a credential\'s expiresOn, and the change persists on re-read', async () => {
    const staff = await makeStaff('Boundary Test Staff Update')
    const addResult = await addCredential({ staffMemberId: staff.id, credentialType: 'DEA Registration', credentialNumber: 'X999', expiresOn: daysFromNow(30) })
    expect(addResult.ok).toBe(true)
    if (!addResult.ok) throw new Error('unreachable')

    const updateResult = await updateCredential(addResult.credential.id, { expiresOn: daysFromNow(400) })
    expect(updateResult.ok).toBe(true)
    if (!updateResult.ok) throw new Error('unreachable')
    expect(updateResult.credential.expiresOn).toBe(daysFromNow(400))

    // Untouched fields are left as-is by a partial update.
    expect(updateResult.credential.credentialType).toBe('DEA Registration')
    expect(updateResult.credential.credentialNumber).toBe('X999')

    const [reread] = await getDb().select().from(staffCredentials).where(eq(staffCredentials.id, addResult.credential.id))
    expect(reread.expiresOn).toBe(daysFromNow(400))
  })

  it('returns an error result for a nonexistent credential id', async () => {
    const result = await updateCredential(999999, { expiresOn: daysFromNow(10) })
    expect(result.ok).toBe(false)
  })
})
