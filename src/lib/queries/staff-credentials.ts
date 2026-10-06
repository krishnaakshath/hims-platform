import { getDb } from '@/db/client'
import { staffCredentials, staffMembers } from '@/db/schema'
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm'

export interface AddCredentialInput {
  staffMemberId: number
  credentialType: string
  credentialNumber?: string | null
  expiresOn?: string | null
}

export type AddCredentialResult =
  | { ok: true; credential: typeof staffCredentials.$inferSelect }
  | { ok: false; error: string }

export async function addCredential(input: AddCredentialInput): Promise<AddCredentialResult> {
  const db = getDb()
  const [staffMember] = await db.select({ id: staffMembers.id }).from(staffMembers).where(eq(staffMembers.id, input.staffMemberId))
  if (!staffMember) return { ok: false, error: 'staffMemberId does not reference an existing staff member' }

  const [credential] = await db.insert(staffCredentials).values({
    staffMemberId: input.staffMemberId,
    credentialType: input.credentialType,
    credentialNumber: input.credentialNumber ?? null,
    expiresOn: input.expiresOn ?? null,
  }).returning()

  return { ok: true, credential }
}

export interface UpdateCredentialInput {
  credentialType?: string
  credentialNumber?: string | null
  expiresOn?: string | null
}

export type UpdateCredentialResult =
  | { ok: true; credential: typeof staffCredentials.$inferSelect }
  | { ok: false; error: string }

// Final whole-branch review, Important #2: there was previously no way to
// correct or renew a credential after creation (e.g. update expiresOn once
// a license is renewed), even though role-capabilities.ts and spec §6 both
// claim admins can "edit staff members and credentials" -- an expired
// credential would otherwise sit on the admin-dashboard alert forever.
// Scoped update, same shape as updateStaffMember: only touches fields the
// caller actually provided; staffMemberId/id stay immutable through this path.
export async function updateCredential(id: number, input: UpdateCredentialInput): Promise<UpdateCredentialResult> {
  const db = getDb()
  const [existing] = await db.select({ id: staffCredentials.id }).from(staffCredentials).where(eq(staffCredentials.id, id))
  if (!existing) return { ok: false, error: 'Credential not found' }

  const updates: Partial<typeof staffCredentials.$inferInsert> = {}
  if (input.credentialType !== undefined) updates.credentialType = input.credentialType
  if (input.credentialNumber !== undefined) updates.credentialNumber = input.credentialNumber
  if (input.expiresOn !== undefined) updates.expiresOn = input.expiresOn

  const [credential] = await db.update(staffCredentials).set(updates).where(eq(staffCredentials.id, id)).returning()
  return { ok: true, credential }
}

export interface ExpiringCredential {
  id: number
  staffMemberId: number
  staffMemberName: string
  credentialType: string
  expiresOn: string
  daysUntilExpiry: number // negative once expired
  status: 'expiring_soon' | 'expired'
}

// "Expiring soon" / "expired" per spec §3: expiresOn non-null and no more
// than 60 days out is expiring_soon; expiresOn in the past is expired; both
// come back together, soonest first. The 60-day cutoff is computed once in
// JS (not a DB-side `+ INTERVAL`), matching this codebase's existing
// plain-date-math convention (see src/lib/queries/ar-dashboard.ts), so the
// exact 60-vs-61-day boundary in Review Focus #2 is unambiguous: a credential
// expiring exactly `cutoff` days out is included, `cutoff + 1` is not.
export async function listExpiringOrExpiredCredentials(): Promise<ExpiringCredential[]> {
  const db = getDb()
  const todayStr = new Date().toISOString().slice(0, 10)
  const cutoffStr = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const rows = await db
    .select({
      id: staffCredentials.id,
      staffMemberId: staffCredentials.staffMemberId,
      staffMemberName: staffMembers.name,
      credentialType: staffCredentials.credentialType,
      expiresOn: staffCredentials.expiresOn,
    })
    .from(staffCredentials)
    .innerJoin(staffMembers, eq(staffMembers.id, staffCredentials.staffMemberId))
    .where(and(
      isNotNull(staffCredentials.expiresOn),
      sql`${staffCredentials.expiresOn} <= ${cutoffStr}`,
      // Fix A (final whole-branch review): a terminated employee's
      // expired/expiring credential must not linger on this list forever --
      // once Task 4 wires this into the admin dashboard's standing alert
      // panel, permanent noise about ex-employees actively degrades the
      // signal it exists to provide. `on_leave` staff are deliberately kept
      // on the list: a credential lapsing while someone's on leave still
      // matters when they return.
      ne(staffMembers.employmentStatus, 'terminated'),
    ))
    .orderBy(asc(staffCredentials.expiresOn))

  return rows.map((r) => {
    const expiresOn = r.expiresOn as string
    const daysUntilExpiry = Math.round((Date.parse(expiresOn) - Date.parse(todayStr)) / (24 * 60 * 60 * 1000))
    return { ...r, expiresOn, daysUntilExpiry, status: expiresOn < todayStr ? 'expired' as const : 'expiring_soon' as const }
  })
}
