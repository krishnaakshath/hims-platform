import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, staffCredentials } from '@/db/schema'

const createdStaffIds: number[] = []
afterEach(async () => {
  while (createdStaffIds.length > 0) {
    const id = createdStaffIds.pop()!
    await getDb().delete(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
    await getDb().delete(staffMembers).where(eq(staffMembers.id, id))
  }
})

describe('staff schema', () => {
  it('creates a staff member with neither userId nor providerId set', async () => {
    const db = getDb()
    const [staff] = await db.insert(staffMembers).values({
      name: 'Test Receptionist', department: 'Front Desk', title: 'Receptionist', hireDate: '2024-01-01',
    }).returning()
    createdStaffIds.push(staff.id)
    expect(staff.userId).toBeNull()
    expect(staff.providerId).toBeNull()
    expect(staff.employmentStatus).toBe('active')
  })

  it('attaches a credential to a staff member', async () => {
    const db = getDb()
    const [staff] = await db.insert(staffMembers).values({
      name: 'Test Clinician', department: 'Clinical', title: 'Psychiatrist', hireDate: '2024-01-01',
    }).returning()
    createdStaffIds.push(staff.id)
    const [cred] = await db.insert(staffCredentials).values({
      staffMemberId: staff.id, credentialType: 'DEA Registration', expiresOn: '2027-01-01',
    }).returning()
    expect(cred.staffMemberId).toBe(staff.id)
    expect(cred.credentialNumber).toBeNull()
  })
})
