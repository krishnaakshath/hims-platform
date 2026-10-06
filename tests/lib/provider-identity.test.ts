import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, providers } from '@/db/schema'
import { resolveSessionProvider } from '@/lib/provider-identity'
import type { Session } from '@/lib/auth'

let kunamUserId: number
let kunamStaffId: number
let kunamProviderId: number
let ruizUserId: number

// NOTE ON LOOKUP STRATEGY: seed.ts links these two staff to demo users by
// email (`pi@` / `crc@` on SEED_EMAIL_DOMAIN). On a shared dev database,
// seed.ts's early-return-when-patients-already-seeded path means that
// `users` insert may never have run, so the `users` rows can carry other
// emails (environmental drift from a concurrent worktree/test run against
// the same shared DB, the same class of hazard the task brief calls out for
// `patients`). Resolving by staff name + the real userId/providerId/employmentStatus links -- the exact
// relational shape resolveSessionProvider is built to walk -- is robust to
// that drift and is what this suite actually needs verified, so we look
// each one up that way instead of by the (currently absent) fixed email.
beforeAll(async () => {
  const db = getDb()

  const [kunamStaff] = await db.select().from(staffMembers).where(eq(staffMembers.name, 'Dr. Rajiv Kunam'))
  if (!kunamStaff || kunamStaff.userId == null || kunamStaff.providerId == null) {
    throw new Error('Seeded staff row for Dr. Rajiv Kunam not found, or missing userId/providerId')
  }
  kunamStaffId = kunamStaff.id
  kunamUserId = kunamStaff.userId
  kunamProviderId = kunamStaff.providerId

  const [ruizStaff] = await db.select().from(staffMembers).where(eq(staffMembers.name, 'Jamie Ruiz'))
  if (!ruizStaff || ruizStaff.userId == null) throw new Error('Seeded staff row for Jamie Ruiz not found, or missing userId')
  if (ruizStaff.providerId !== null) throw new Error('Expected seeded Jamie Ruiz staff row to have providerId: null')
  ruizUserId = ruizStaff.userId
})

// Every test that mutates employmentStatus/isActive snapshots the row first
// and restores it here, so this suite never leaves seed data in a mutated
// state for other tests/suites that depend on it.
let staffSnapshot: { employmentStatus: 'active' | 'on_leave' | 'terminated' } | null = null
let providerSnapshot: { isActive: boolean } | null = null

afterEach(async () => {
  const db = getDb()
  if (staffSnapshot) {
    await db.update(staffMembers).set({ employmentStatus: staffSnapshot.employmentStatus }).where(eq(staffMembers.id, kunamStaffId))
    staffSnapshot = null
  }
  if (providerSnapshot) {
    await db.update(providers).set({ isActive: providerSnapshot.isActive }).where(eq(providers.id, kunamProviderId))
    providerSnapshot = null
  }
})

describe('resolveSessionProvider', () => {
  it('resolves the seeded pi across the name divergence', async () => {
    const session: Session = { role: 'pi', name: 'Dr. R. Kunam', userId: kunamUserId }
    const result = await resolveSessionProvider(session)
    expect(result).toEqual({ id: kunamProviderId, name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Psychiatry' })
  })

  it('returns null for userId: null (the env-admin account)', async () => {
    const session: Session = { role: 'admin', name: 'Sam Patel', userId: null }
    expect(await resolveSessionProvider(session)).toBeNull()
  })

  it('returns null when userId is absent entirely, the shape a vi.mock("@/lib/auth") factory returns', async () => {
    const session = { role: 'admin', name: 'Sam Patel' } as never
    expect(await resolveSessionProvider(session)).toBeNull()
  })

  it('returns null for a userId with no staff_members row at all', async () => {
    const session: Session = { role: 'pi', name: 'Nobody', userId: 9_999_999 }
    expect(await resolveSessionProvider(session)).toBeNull()
  })

  it('returns null for a staff member whose providerId is null (the seeded crc Jamie Ruiz)', async () => {
    const session: Session = { role: 'crc', name: 'Jamie Ruiz', userId: ruizUserId }
    expect(await resolveSessionProvider(session)).toBeNull()
  })

  it('returns null when the staff member is terminated or on_leave', async () => {
    const db = getDb()
    const [current] = await db.select({ employmentStatus: staffMembers.employmentStatus }).from(staffMembers).where(eq(staffMembers.id, kunamStaffId))
    staffSnapshot = { employmentStatus: current.employmentStatus }

    await db.update(staffMembers).set({ employmentStatus: 'terminated' }).where(eq(staffMembers.id, kunamStaffId))
    expect(await resolveSessionProvider({ role: 'pi', name: 'Dr. R. Kunam', userId: kunamUserId })).toBeNull()

    await db.update(staffMembers).set({ employmentStatus: 'on_leave' }).where(eq(staffMembers.id, kunamStaffId))
    expect(await resolveSessionProvider({ role: 'pi', name: 'Dr. R. Kunam', userId: kunamUserId })).toBeNull()
  })

  it('returns null when the provider row is isActive: false', async () => {
    const db = getDb()
    const [current] = await db.select({ isActive: providers.isActive }).from(providers).where(eq(providers.id, kunamProviderId))
    providerSnapshot = { isActive: current.isActive }

    await db.update(providers).set({ isActive: false }).where(eq(providers.id, kunamProviderId))
    expect(await resolveSessionProvider({ role: 'pi', name: 'Dr. R. Kunam', userId: kunamUserId })).toBeNull()
  })
})
