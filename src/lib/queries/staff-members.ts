import { getDb } from '@/db/client'
import { staffMembers, staffCredentials, users, providers } from '@/db/schema'
import { asc, eq, and } from 'drizzle-orm'
import type { SessionProvider } from '@/lib/provider-identity'

export interface CreateStaffMemberInput {
  userId: number | null
  providerId: number | null
  name: string
  department: string
  title: string
  employmentStatus?: 'active' | 'on_leave' | 'terminated'
  hireDate: string
  terminationDate?: string | null
}

export type CreateStaffMemberResult =
  | { ok: true; staffMember: typeof staffMembers.$inferSelect }
  | { ok: false; error: string }

export async function listStaffMembers() {
  return getDb().select().from(staffMembers).orderBy(asc(staffMembers.name))
}

export async function getStaffMemberDetail(id: number) {
  const [staffMember] = await getDb().select().from(staffMembers).where(eq(staffMembers.id, id))
  if (!staffMember) return null
  const credentials = await getDb().select().from(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
  return { ...staffMember, credentials }
}

// Verifies userId/providerId reference real rows before insert (Review
// Focus #1) -- a dangling FK here would otherwise either throw an unhandled
// Postgres constraint error, or (if the columns were made nullable-without-
// checking) silently store a reference to nothing.
export async function createStaffMember(input: CreateStaffMemberInput): Promise<CreateStaffMemberResult> {
  const db = getDb()
  if (input.userId !== null) {
    const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId))
    if (!userRow) return { ok: false, error: 'userId does not reference an existing user' }
  }
  if (input.providerId !== null) {
    const [providerRow] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, input.providerId))
    if (!providerRow) return { ok: false, error: 'providerId does not reference an existing provider' }
  }

  const [staffMember] = await db.insert(staffMembers).values({
    userId: input.userId,
    providerId: input.providerId,
    name: input.name,
    department: input.department,
    title: input.title,
    employmentStatus: input.employmentStatus ?? 'active',
    hireDate: input.hireDate,
    terminationDate: input.terminationDate ?? null,
  }).returning()

  return { ok: true, staffMember }
}

export interface UpdateStaffMemberInput {
  employmentStatus?: 'active' | 'on_leave' | 'terminated'
  terminationDate?: string | null
  department?: string
  title?: string
}

export type UpdateStaffMemberResult =
  | { ok: true; staffMember: typeof staffMembers.$inferSelect }
  | { ok: false; error: string }

// Fix B (final whole-branch review): the directory was write-once -- no
// route could ever change a staff member after creation, which meant (1)
// role-capabilities.ts's admin bullet "Add and edit staff members..." was
// false, and (2) the `terminated` employment-status soft-delete path was
// unreachable. Scoped to the fields a real HR change would touch --
// employmentStatus/terminationDate/department/title -- not a full
// replace-everything PUT; userId/providerId/name/hireDate stay immutable
// through this path, matching how the rest of this module treats identity
// fields set at creation.
export async function updateStaffMember(id: number, input: UpdateStaffMemberInput): Promise<UpdateStaffMemberResult> {
  const db = getDb()
  const [existing] = await db.select({ id: staffMembers.id }).from(staffMembers).where(eq(staffMembers.id, id))
  if (!existing) return { ok: false, error: 'Staff member not found' }

  const updates: Partial<typeof staffMembers.$inferInsert> = {}
  if (input.employmentStatus !== undefined) updates.employmentStatus = input.employmentStatus
  if (input.terminationDate !== undefined) updates.terminationDate = input.terminationDate
  if (input.department !== undefined) updates.department = input.department
  if (input.title !== undefined) updates.title = input.title

  const [staffMember] = await db.update(staffMembers).set(updates).where(eq(staffMembers.id, id)).returning()
  return { ok: true, staffMember }
}

// The real users -> staffMembers -> providers link a session's userId
// resolves to (see resolveSessionProvider in provider-identity.ts). Both
// status filters matter: an 8-hour session cookie outlives an HR change, so
// a staff member whose employment has ended (terminated/on_leave) must not
// still be able to prescribe under this link, and a provider row that's
// since been deactivated must not be attributed a new prescription either.
export async function getProviderForUserId(userId: number): Promise<SessionProvider | null> {
  const [row] = await getDb()
    .select({ id: providers.id, name: providers.name, credentials: providers.credentials, specialty: providers.specialty })
    .from(staffMembers)
    .innerJoin(providers, eq(staffMembers.providerId, providers.id))
    .where(and(eq(staffMembers.userId, userId), eq(staffMembers.employmentStatus, 'active'), eq(providers.isActive, true)))

  return row ?? null
}
