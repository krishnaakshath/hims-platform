// WS4 T11: verifier department resolution and the doctor's acknowledgement / co-sign of a lab
// result (spec 3.4). Identity is the session's staff link ONLY (resolveSessionProvider): never the
// surname fallback, so a sign-off is always attributable to a real provider row.
//
// Lock order: the lab_orders row (`for update`), then the active admission is only read. Same
// first lock as every lab lifecycle write, so no new deadlock path.
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, labOrders, labResultSignoffs, providers, type LabSignoffKind } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { LabOrderStatus } from '@/lib/labs/status'
import { resolveSessionProvider } from '@/lib/provider-identity'

/** The department of the provider this session is linked to (staff link only), or null. */
export async function resolveVerifierDepartmentId(session: Session): Promise<number | null> {
  const provider = await resolveSessionProvider(session)
  if (!provider) return null
  const [row] = await getDb().select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, provider.id))
  return row?.departmentId ?? null
}

/** Statuses on which each sign-off may be recorded: acknowledge a (preliminary or final) result, co-sign a verified one. */
export const SIGNOFF_STATUSES: Record<LabSignoffKind, readonly LabOrderStatus[]> = {
  acknowledge: ['resulted', 'verified', 'reported'],
  cosign: ['verified', 'reported'],
}

/** Whitespace-collapsed, case-insensitive name comparison for the co-sign's typed name. */
export function sameSignatureName(typed: string, sessionName: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN')
  return norm(typed) !== '' && norm(typed) === norm(sessionName)
}

export type SignOffError = 'not_found' | 'not_verified' | 'not_owner' | 'name_mismatch' | 'already_signed'

/**
 * Records an acknowledgement or a co-sign by the session's linked provider. The owner is the
 * ordering provider or the attending of the patient's active admission. One of each kind per
 * provider per order: a repeat (or a concurrent duplicate) is `already_signed`, never a 500.
 * Audits ids only (the note is stored, never audited).
 */
export async function signOffLabResult(
  orderId: number,
  kind: LabSignoffKind,
  i: { note: string | null; typedName?: string },
  session: Session,
  now: Date = new Date(),
): Promise<{ ok: true; providerId: number } | { ok: false; error: SignOffError }> {
  const provider = await resolveSessionProvider(session)
  return getDb().transaction(async (tx) => {
    const [order] = await tx
      .select({ id: labOrders.id, status: labOrders.status, patientId: labOrders.patientId, orderedByProviderId: labOrders.orderedByProviderId })
      .from(labOrders).where(eq(labOrders.id, orderId)).for('update')
    if (!order) return { ok: false, error: 'not_found' } as const
    if (!SIGNOFF_STATUSES[kind].includes(order.status)) return { ok: false, error: 'not_verified' } as const
    if (!provider) return { ok: false, error: 'not_owner' } as const
    let owner = provider.id === order.orderedByProviderId
    if (!owner) {
      const [adm] = await tx.select({ id: admissions.id }).from(admissions)
        .where(and(eq(admissions.patientId, order.patientId), eq(admissions.status, 'admitted'), eq(admissions.attendingProviderId, provider.id)))
        .limit(1)
      owner = adm !== undefined
    }
    if (!owner) return { ok: false, error: 'not_owner' } as const
    if (kind === 'cosign' && !sameSignatureName(i.typedName ?? '', session.name)) return { ok: false, error: 'name_mismatch' } as const

    const inserted = await tx.insert(labResultSignoffs)
      .values({ labOrderId: orderId, kind, providerId: provider.id, userId: session.userId, signedByName: session.name, note: i.note, signedAt: now })
      .onConflictDoNothing({ target: [labResultSignoffs.labOrderId, labResultSignoffs.kind, labResultSignoffs.providerId] })
      .returning({ id: labResultSignoffs.id })
    if (inserted.length === 0) return { ok: false, error: 'already_signed' } as const
    await logAudit(session, kind === 'acknowledge' ? 'acknowledged lab result' : 'co-signed lab result', order.patientId, `order=${orderId} signoff=${inserted[0].id}`, tx)
    return { ok: true, providerId: provider.id } as const
  })
}

export interface SignoffRow {
  orderId: number
  kind: LabSignoffKind
  providerId: number
  providerName: string
  signedByName: string
  signedAt: Date
}

/** Every sign-off of the given orders, oldest first, keyed by order id. Notes are not returned. */
export async function listSignoffs(orderIds: number[]): Promise<Map<number, SignoffRow[]>> {
  const out = new Map<number, SignoffRow[]>()
  const ids = [...new Set(orderIds)]
  if (ids.length === 0) return out
  const rows = await getDb()
    .select({
      orderId: labResultSignoffs.labOrderId, kind: labResultSignoffs.kind, providerId: labResultSignoffs.providerId,
      providerName: providers.name, signedByName: labResultSignoffs.signedByName, signedAt: labResultSignoffs.signedAt,
    })
    .from(labResultSignoffs)
    .innerJoin(providers, eq(providers.id, labResultSignoffs.providerId))
    .where(inArray(labResultSignoffs.labOrderId, ids))
    .orderBy(asc(labResultSignoffs.signedAt), asc(labResultSignoffs.id))
  for (const r of rows) out.set(r.orderId, [...(out.get(r.orderId) ?? []), r])
  return out
}
