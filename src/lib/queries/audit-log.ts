import { z } from 'zod'
import { and, desc, eq, gte, ilike, inArray, lt, lte, max as sqlMax, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patients } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'
import { istDateOf, startOfIstDay } from '@/lib/india-time'

/**
 * Shared by the /api/audit-log route handlers and the Audit Log Server
 * Component page — see the comment on `listPatientsWithStatus` in
 * `src/lib/queries/patients.ts` for why Server Components must call this
 * directly rather than fetching the app's own API route.
 *
 * WS8 T12 (spec D19): filters, keyset pagination (50 per page) on
 * (timestamp, id) and a capped iterator for the CSV export. Entries carry the
 * patient's UHID, never the chart id.
 */
export interface AuditLogEntry {
  id: number
  userName: string
  role: Role | null
  action: string
  patientUhid: string | null
  timestamp: Date
  details: string | null
}

export interface AuditLogFilters {
  user?: string
  role?: Role
  /** UHID or chart id, resolved to patient_id. */
  patient?: string
  /** Case-insensitive "contains". */
  action?: string
  /** IST calendar dates (YYYY-MM-DD), inclusive. */
  from?: string
  to?: string
  /** Searches user, action and details. */
  q?: string
}

/** `ts` is the row's timestamp at full (microsecond) precision, so ties on a millisecond never skip a row. */
export type AuditCursor = { ts: string; id: number }

export const AUDIT_PAGE_SIZE = 50
export const AUDIT_EXPORT_MAX_ROWS = 50_000
export const AUDIT_FILTER_KEYS = ['user', 'role', 'patient', 'action', 'from', 'to', 'q'] as const

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function encodeAuditCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

export function decodeAuditCursor(raw: string): AuditCursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof v !== 'object' || v === null) return null
    const { ts, id } = v as Record<string, unknown>
    if (typeof ts !== 'string' || !CURSOR_TS.test(ts) || !Number.isSafeInteger(id) || (id as number) < 1) return null
    return { ts, id: id as number }
  } catch {
    return null
  }
}

// A blank form field arrives as `?user=`; treat it as "no filter".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v), schema.optional())

// A real calendar date: 2026-02-30 does not round-trip and is refused.
const isoDate = z.string().regex(ISO_DATE).refine((s) => !Number.isNaN(startOfIstDay(s).getTime()) && istDateOf(startOfIstDay(s)) === s)

const filterShape = {
  user: optional(z.string().max(100)),
  role: optional(z.enum(ALL_ROLES)),
  patient: optional(z.string().max(64)),
  action: optional(z.string().max(200)),
  from: optional(isoDate),
  to: optional(isoDate),
  q: optional(z.string().max(200)),
}

const listQuerySchema = z.object({ ...filterShape, cursor: optional(z.string().max(200)) }).strict()
const exportQuerySchema = z.object(filterShape).strict()

export type AuditQueryResult =
  | { ok: true; filters: AuditLogFilters; cursor?: AuditCursor }
  | { ok: false }

/** Parses URL query params strictly (unknown keys, bad role, bad dates, from after to, bad cursor all fail). */
export function parseAuditLogQuery(params: Record<string, string | string[] | undefined>, opts: { allowCursor: boolean }): AuditQueryResult {
  const flat = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v[v.length - 1] : v]))
  const parsed = (opts.allowCursor ? listQuerySchema : exportQuerySchema).safeParse(flat)
  if (!parsed.success) return { ok: false }
  const { cursor: rawCursor, ...rest } = parsed.data as AuditLogFilters & { cursor?: string }
  if (rest.from && rest.to && rest.from > rest.to) return { ok: false }
  const filters = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as AuditLogFilters
  if (rawCursor === undefined) return { ok: true, filters }
  const cursor = decodeAuditCursor(rawCursor)
  return cursor ? { ok: true, filters, cursor } : { ok: false }
}

/** The filter keys in use, in canonical order (never their values). */
export function activeFilterKeys(filters: AuditLogFilters): string[] {
  return AUDIT_FILTER_KEYS.filter((k) => filters[k] !== undefined)
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

const contains = (s: string) => `%${escapeLike(s)}%`
const DAY_MS = 24 * 60 * 60 * 1000

/** Bounds an export to the rows that existed when it started (see auditLogSnapshot). */
export type AuditSnapshot = { maxId: number }

async function whereFor(filters: AuditLogFilters, snapshot?: AuditSnapshot): Promise<SQL | undefined> {
  const conds: (SQL | undefined)[] = []
  if (snapshot) conds.push(lte(auditLog.id, snapshot.maxId))
  if (filters.user) conds.push(ilike(auditLog.userName, contains(filters.user)))
  if (filters.role) conds.push(eq(auditLog.role, filters.role))
  if (filters.action) conds.push(ilike(auditLog.action, contains(filters.action)))
  if (filters.from) conds.push(gte(auditLog.timestamp, startOfIstDay(filters.from)))
  if (filters.to) conds.push(lt(auditLog.timestamp, new Date(startOfIstDay(filters.to).getTime() + DAY_MS)))
  if (filters.q) {
    const p = contains(filters.q)
    conds.push(or(ilike(auditLog.userName, p), ilike(auditLog.action, p), ilike(auditLog.details, p)))
  }
  if (filters.patient) {
    const candidates = [...new Set([filters.patient, filters.patient.toUpperCase()])]
    const [hit] = await getDb().select({ id: patients.id }).from(patients)
      .where(or(inArray(patients.uhid, candidates), inArray(patients.id, candidates))).limit(1)
    // An id with no patient row (e.g. a since-deleted chart) still matches its own audit rows.
    conds.push(eq(auditLog.patientId, hit?.id ?? filters.patient))
  }
  return and(...conds)
}

async function page(where: SQL | undefined, cursor: AuditCursor | undefined, limit: number) {
  const keyset = cursor ? sql`(${auditLog.timestamp}, ${auditLog.id}) < (${cursor.ts}::timestamp, ${cursor.id})` : undefined
  return getDb()
    .select({
      id: auditLog.id,
      userName: auditLog.userName,
      role: auditLog.role,
      action: auditLog.action,
      patientUhid: patients.uhid,
      timestamp: auditLog.timestamp,
      details: auditLog.details,
      cursorTs: sql<string>`to_char(${auditLog.timestamp}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
    })
    .from(auditLog)
    .leftJoin(patients, eq(patients.id, auditLog.patientId))
    .where(and(where, keyset))
    .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
    .limit(limit)
}

function strip(row: Awaited<ReturnType<typeof page>>[number]): AuditLogEntry {
  return { id: row.id, userName: row.userName, role: row.role, action: row.action, patientUhid: row.patientUhid, timestamp: row.timestamp, details: row.details }
}

export async function listAuditLog(filters: AuditLogFilters, cursor?: AuditCursor, pageSize = AUDIT_PAGE_SIZE): Promise<{ entries: AuditLogEntry[]; nextCursor: AuditCursor | null }> {
  const size = Math.max(1, Math.min(pageSize, 1000))
  const rows = await page(await whereFor(filters), cursor, size + 1)
  const more = rows.length > size
  const kept = more ? rows.slice(0, size) : rows
  const last = kept[kept.length - 1]
  return { entries: kept.map(strip), nextCursor: more && last ? { ts: last.cursorTs, id: last.id } : null }
}

/** The newest audit row id now: an export counts and streams only rows up to it, so its own audit row is never in the file. */
export async function auditLogSnapshot(): Promise<AuditSnapshot> {
  const [r] = await getDb().select({ maxId: sqlMax(auditLog.id) }).from(auditLog)
  return { maxId: r?.maxId ?? 0 }
}

/** Matching rows, counted up to `cap + 1` so a huge log is never fully counted. */
export async function countAuditLog(filters: AuditLogFilters, cap = AUDIT_EXPORT_MAX_ROWS, snapshot?: AuditSnapshot): Promise<number> {
  const where = await whereFor(filters, snapshot)
  const inner = getDb().select({ one: sql`1` }).from(auditLog).where(where).limit(cap + 1).as('matching')
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(inner)
  return r?.n ?? 0
}

/** Every matching entry, newest first, in keyset batches, stopping after `max`. */
export async function* iterateAuditLog(filters: AuditLogFilters, max = AUDIT_EXPORT_MAX_ROWS, snapshot?: AuditSnapshot): AsyncGenerator<AuditLogEntry> {
  const where = await whereFor(filters, snapshot)
  const BATCH = 1000
  let cursor: AuditCursor | undefined
  let sent = 0
  while (sent < max) {
    const want = Math.min(BATCH, max - sent)
    const rows = await page(where, cursor, want)
    for (const row of rows) yield strip(row)
    sent += rows.length
    const last = rows[rows.length - 1]
    if (!last || rows.length < want) return
    cursor = { ts: last.cursorTs, id: last.id }
  }
}
