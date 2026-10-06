import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, users, providers } from '@/db/schema'
import { listStaffMembers, getStaffMemberDetail, createStaffMember } from '@/lib/queries/staff-members'

const createdStaffIds: number[] = []
afterEach(async () => {
  while (createdStaffIds.length > 0) await getDb().delete(staffMembers).where(eq(staffMembers.id, createdStaffIds.pop()!))
})

describe('staff members queries', () => {
  it('creates a staff member with no userId/providerId, then lists and gets it', async () => {
    const result = await createStaffMember({ userId: null, providerId: null, name: 'Test Staff A', department: 'Front Desk', title: 'Receptionist', hireDate: '2024-01-01' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    createdStaffIds.push(result.staffMember.id)

    const all = await listStaffMembers()
    expect(all.some((s) => s.id === result.staffMember.id)).toBe(true)

    const detail = await getStaffMemberDetail(result.staffMember.id)
    expect(detail?.name).toBe('Test Staff A')
    expect(detail?.credentials).toEqual([])
  })

  it('creates a staff member linked to a real user and a real provider', async () => {
    const db = getDb()
    const [userRow] = await db.select().from(users).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    const result = await createStaffMember({ userId: userRow.id, providerId: providerRow.id, name: 'Test Staff B', department: 'Clinical', title: 'Psychiatrist', hireDate: '2024-01-01' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    createdStaffIds.push(result.staffMember.id)
    expect(result.staffMember.userId).toBe(userRow.id)
    expect(result.staffMember.providerId).toBe(providerRow.id)
  })

  it('rejects a userId that does not exist', async () => {
    const result = await createStaffMember({ userId: 999999, providerId: null, name: 'Test Staff C', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' })
    expect(result.ok).toBe(false)
  })

  it('rejects a providerId that does not exist', async () => {
    const result = await createStaffMember({ userId: null, providerId: 999999, name: 'Test Staff D', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' })
    expect(result.ok).toBe(false)
  })
})
