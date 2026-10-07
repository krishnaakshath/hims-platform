// Service catalogue <-> procedure-code map reads and writes (SP6 Task 14). The map stores kind +
// code value only (ruling 15): a code is validated against its kind's CURRENT version when written,
// and reads join the current version for its display. No PHI is involved.
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { codeSystems, codes, serviceCatalog, serviceProcedureCodes } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CODE_PATTERN, CODE_SYSTEM_LABEL, normalizeCode, type CodeSystemKind } from '@/lib/coding/code-systems'
import { MAPPABLE_SERVICE_CATEGORIES, serviceCodeProblems } from '@/lib/coding/service-codes'
import type { ServiceCategory } from '@/lib/tariff/validation'
import { findCurrentCode, escapeLike } from './code-systems'
import { refusesSampleCodes } from './coding'

export interface ServiceProcedureCodeRow {
  serviceId: number
  kind: CodeSystemKind
  code: string
  isPrimary: boolean
  /** From the kind's current version; null when the code is not in it (e.g. a newer release dropped it). */
  display: string | null
  isSample: boolean
}

export interface MappableService {
  id: number
  code: string
  name: string
  category: ServiceCategory
  isActive: boolean
}

export type ReplaceServiceCodesResult =
  | { ok: true }
  | { ok: false; error: 'service_not_found' | 'incompatible' | 'code_not_found'; problems?: string[] }

export const SERVICE_LIST_LIMIT = 200

/** Services whose category can carry procedure codes, by code then name; `q` matches code or name. */
export async function listMappableServices(q = ''): Promise<MappableService[]> {
  const term = q.trim().slice(0, 60)
  const pattern = `%${escapeLike(term)}%`
  return getDb()
    .select({ id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, category: serviceCatalog.category, isActive: serviceCatalog.isActive })
    .from(serviceCatalog)
    .where(and(
      inArray(serviceCatalog.category, MAPPABLE_SERVICE_CATEGORIES),
      term ? or(ilike(serviceCatalog.code, pattern), ilike(serviceCatalog.name, pattern)) : undefined,
    ))
    .orderBy(desc(serviceCatalog.isActive), asc(serviceCatalog.code))
    .limit(SERVICE_LIST_LIMIT)
}

/** The mapped codes of each service (primary first, then kind and code); unmapped services are absent. */
export async function listServiceProcedureCodes(serviceIds: number[]): Promise<Map<number, ServiceProcedureCodeRow[]>> {
  const out = new Map<number, ServiceProcedureCodeRow[]>()
  const ids = [...new Set(serviceIds)]
  if (ids.length === 0) return out
  const rows = await getDb()
    .select({
      serviceId: serviceProcedureCodes.serviceId,
      kind: serviceProcedureCodes.codeSystemKind,
      code: serviceProcedureCodes.code,
      isPrimary: serviceProcedureCodes.isPrimary,
      display: codes.display,
      isSample: codeSystems.isSample,
    })
    .from(serviceProcedureCodes)
    .leftJoin(codeSystems, and(eq(codeSystems.kind, serviceProcedureCodes.codeSystemKind), eq(codeSystems.isCurrent, true)))
    .leftJoin(codes, and(eq(codes.codeSystemId, codeSystems.id), eq(codes.code, serviceProcedureCodes.code)))
    .where(inArray(serviceProcedureCodes.serviceId, ids))
    .orderBy(desc(serviceProcedureCodes.isPrimary), asc(serviceProcedureCodes.codeSystemKind), asc(serviceProcedureCodes.code))
  for (const r of rows) {
    const row: ServiceProcedureCodeRow = { ...r, display: r.display ?? null, isSample: r.isSample ?? false }
    out.set(r.serviceId, [...(out.get(r.serviceId) ?? []), row])
  }
  return out
}

class Refusal extends Error {
  constructor(readonly result: Exclude<ReplaceServiceCodesResult, { ok: true }>) { super('refused') }
}

/**
 * Replace a service's whole map in one transaction: lock the service row, check the category fits
 * every kind, check every code is active and selectable in its kind's current version (and not
 * from a sample set in production), then delete + insert and audit inside the transaction.
 */
export async function replaceServiceProcedureCodes(
  serviceId: number,
  input: { kind: CodeSystemKind; code: string; isPrimary: boolean }[],
  session: Session,
): Promise<ReplaceServiceCodesResult> {
  const list = input.map((c) => ({ ...c, code: normalizeCode(c.code) }))
  try {
    return await getDb().transaction(async (tx) => {
      const [service] = await tx.select({ id: serviceCatalog.id, category: serviceCatalog.category })
        .from(serviceCatalog).where(eq(serviceCatalog.id, serviceId)).for('update')
      if (!service) throw new Refusal({ ok: false, error: 'service_not_found' })

      const shape: string[] = serviceCodeProblems(service.category, list)
      const seen = new Set<string>()
      for (const c of list) {
        const k = `${c.kind}:${c.code}`
        if (seen.has(k) && CODE_PATTERN[c.kind].test(c.code)) shape.push(`${c.code} is listed more than once`)
        seen.add(k)
      }
      if (list.filter((c) => c.isPrimary).length > 1) shape.push('Only one code can be primary')
      if (shape.length) throw new Refusal({ ok: false, error: 'incompatible', problems: shape })

      const missing: string[] = []
      for (const c of list) {
        const label = CODE_SYSTEM_LABEL[c.kind]
        // Only a well-formed code value is quoted back; anything else is described, never echoed.
        if (!CODE_PATTERN[c.kind].test(c.code)) { missing.push(`A ${label} code is not in the expected format`); continue }
        const found = await findCurrentCode(c.kind, c.code, tx)
        if (!found || !found.active) missing.push(`${c.code} is not an active ${label} code in the current version`)
        else if (!found.selectable) missing.push(`${c.code} is a category heading and cannot be mapped`)
        else if (found.isSample && refusesSampleCodes()) missing.push(`${c.code} is from a sample (fictional) code set`)
      }
      if (missing.length) throw new Refusal({ ok: false, error: 'code_not_found', problems: missing })

      await tx.delete(serviceProcedureCodes).where(eq(serviceProcedureCodes.serviceId, serviceId))
      if (list.length) {
        await tx.insert(serviceProcedureCodes).values(list.map((c) => ({
          serviceId, codeSystemKind: c.kind, code: c.code, isPrimary: c.isPrimary, createdByName: session.name,
        })))
      }
      await logAudit(session, 'coding: replaced service procedure codes', null, `service=${serviceId} codes=${list.length}`, tx)
      return { ok: true } as const
    })
  } catch (err) {
    if (err instanceof Refusal) return err.result
    throw err
  }
}
