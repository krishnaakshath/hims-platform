// Coding worklist and the productivity/backlog report (SP6 Task 10).
//
// - Every filter, page, count and aggregate runs IN SQL; nothing is fetched unbounded and then
//   filtered in memory. The worklist is one page query (WORKLIST_PAGE_SIZE rows, per-row counts as
//   correlated subqueries, so no N+1) plus one grouped count query; `total` is derived from the
//   raw counts, so a "showing N of total" never under-reports.
// - Oldest completion first, over every not-yet-finalised visit, so old work is never starved by
//   new work (the SP3 recall lesson).
// - Coder minimum PHI (ruling 4): patient id, name and UHID only. No dob, contact, address,
//   ABHA or insurance column is read.
// - Dates are IST calendar days of the visit's completion instant (a UTC timestamp):
//   `completed_at`, or for a completed row that lacks it (legacy data) its status-change time and
//   then its check-in time, so no completed visit is ever missing from the worklist or backlog.
//   Instant bounds are passed as ISO strings cast to timestamp, never raw Date params in sql``.
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  codingQueries, departments, diagnoses, encounterCoding, encounterCodingEvents, encounterProcedures, encounters, patients,
  providers,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { ENCOUNTER_CODING_STATUSES, type EncounterCodingStatus } from '@/lib/coding/status'
import {
  BACKLOG_AGE_BUCKETS, WORKLIST_PAGE_SIZE, addIsoDays, backlogAgeBucket, type BacklogAgeBucket, type CodingWorklistFilters,
} from '@/lib/coding/worklist'
import type { EncounterType } from '@/lib/encounters/status'
import { DEFAULT_TIMEZONE, istDateOf, startOfIstDay, todayIsoIn } from '@/lib/india-time'

export interface CodingWorklistRow {
  encounterId: number
  encounterType: EncounterType
  encounterDate: string
  completedAt: Date
  completedIstDate: string
  patientId: string
  patientName: string
  uhid: string | null
  departmentName: string | null
  providerName: string
  codingStatus: EncounterCodingStatus
  assignedToName: string | null
  assignedToUserId: number | null
  /** Live diagnoses + procedures still `uncoded`. */
  uncodedCount: number
  /** Live diagnoses + procedures a doctor `proposed`, awaiting the coder. */
  proposedCount: number
  /** Coding queries not yet closed or withdrawn (`open` or `answered`). */
  openQueryCount: number
  ageBucket: BacklogAgeBucket
}

const CODED_ENCOUNTER_TYPES = ['opd', 'ipd'] as const

/** The visit's completion instant; legacy completed rows without `completed_at` fall back. */
const completedAtSql = sql<Date>`coalesce(${encounters.completedAt}, ${encounters.statusChangedAt}, ${encounters.checkedInAt})`
  .mapWith(encounters.completedAt)
/** An instant as a timestamp literal (UTC wall time; the stored columns are UTC `timestamp`). */
const instant = (d: Date) => sql`${d.toISOString()}::timestamp`

/** The encounter's coding status; no coding row reads `uncoded`. */
const codingStatusSql = sql<EncounterCodingStatus>`coalesce(${encounterCoding.status}, 'uncoded')`

const zeroCounts = (): Record<EncounterCodingStatus, number> =>
  Object.fromEntries(ENCOUNTER_CODING_STATUSES.map((s) => [s, 0])) as Record<EncounterCodingStatus, number>

/** Completed OPD/IPD encounters matching every filter except the status. */
function baseConditions(f: CodingWorklistFilters, session: Session): SQL[] {
  const c: (SQL | undefined)[] = [
    eq(encounters.status, 'completed'),
    f.encounterType ? eq(encounters.encounterType, f.encounterType) : inArray(encounters.encounterType, [...CODED_ENCOUNTER_TYPES]),
    f.departmentId !== null ? eq(encounters.departmentId, f.departmentId) : undefined,
    f.fromDate ? sql`${completedAtSql} >= ${instant(startOfIstDay(f.fromDate))}` : undefined,
    f.toDate ? sql`${completedAtSql} < ${instant(startOfIstDay(addIsoDays(f.toDate, 1)))}` : undefined,
  ]
  if (f.assignee === 'mine') c.push(session.userId === null ? sql`false` : eq(encounterCoding.assignedToUserId, session.userId))
  if (f.assignee === 'unassigned') c.push(isNull(encounterCoding.assignedToUserId))
  return c.filter((x): x is SQL => x !== undefined)
}

function statusCondition(status: CodingWorklistFilters['status']): SQL {
  if (status === 'pending') return sql`${codingStatusSql} <> 'finalised'`
  return sql`${codingStatusSql} = ${status}`
}

const liveEntryCount = (status: 'uncoded' | 'proposed') => sql<number>`(
  (select count(*) from ${diagnoses} where ${diagnoses.encounterId} = ${encounters.id} and ${diagnoses.voidedAt} is null and ${diagnoses.codingStatus} = ${status})
  + (select count(*) from ${encounterProcedures} where ${encounterProcedures.encounterId} = ${encounters.id} and ${encounterProcedures.voidedAt} is null and ${encounterProcedures.codingStatus} = ${status})
)::int`

const openQueryCount = sql<number>`(
  select count(*) from ${codingQueries} where ${codingQueries.encounterId} = ${encounters.id} and ${codingQueries.status} in ('open', 'answered')
)::int`

export async function listCodingWorklist(
  filters: CodingWorklistFilters, session: Session, now: Date = new Date(),
): Promise<{ rows: CodingWorklistRow[]; total: number; counts: Record<EncounterCodingStatus, number> }> {
  const db = getDb()
  const base = baseConditions(filters, session)

  const countRows = await db
    .select({ status: codingStatusSql, n: sql<number>`count(*)::int` })
    .from(encounters)
    .leftJoin(encounterCoding, eq(encounterCoding.encounterId, encounters.id))
    .where(and(...base))
    .groupBy(codingStatusSql)
  const counts = zeroCounts()
  for (const r of countRows) counts[r.status] = Number(r.n)
  const total = filters.status === 'pending'
    ? ENCOUNTER_CODING_STATUSES.filter((s) => s !== 'finalised').reduce((sum, s) => sum + counts[s], 0)
    : counts[filters.status]
  if (total === 0) return { rows: [], total, counts }

  const raw = await db
    .select({
      encounterId: encounters.id,
      encounterType: encounters.encounterType,
      encounterDate: encounters.encounterDate,
      completedAt: completedAtSql,
      patientId: encounters.patientId,
      patientName: patients.name,
      uhid: patients.uhid,
      departmentName: departments.name,
      providerName: providers.name,
      codingStatus: codingStatusSql,
      assignedToName: encounterCoding.assignedToName,
      assignedToUserId: encounterCoding.assignedToUserId,
      uncodedCount: liveEntryCount('uncoded'),
      proposedCount: liveEntryCount('proposed'),
      openQueryCount,
    })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .leftJoin(encounterCoding, eq(encounterCoding.encounterId, encounters.id))
    .where(and(...base, statusCondition(filters.status)))
    .orderBy(asc(completedAtSql), asc(encounters.id))
    .limit(WORKLIST_PAGE_SIZE)
    .offset((filters.page - 1) * WORKLIST_PAGE_SIZE)

  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  const rows = raw.map((r): CodingWorklistRow => {
    const completedAt = r.completedAt
    const completedIstDate = istDateOf(completedAt)
    return {
      ...r,
      completedAt,
      completedIstDate,
      uncodedCount: Number(r.uncodedCount),
      proposedCount: Number(r.proposedCount),
      openQueryCount: Number(r.openQueryCount),
      ageBucket: backlogAgeBucket(completedIstDate, today),
    }
  })
  return { rows, total, counts }
}

// ---------------------------------------------------------------------------------------------
// Productivity and backlog
// ---------------------------------------------------------------------------------------------

export interface CodingProductivity {
  from: string
  to: string
  perCoder: {
    /** The acting user account; null for a session without one (the env-configured admin). */
    userId: number | null
    /** The account's most recent display name in the range. */
    name: string
    claimed: number
    coded: number
    finalised: number
    queriesRaised: number
    reopened: number
    /** Median hours from the visit's completion to each `finalise` in the range; null when none. */
    medianHoursToFinalise: number | null
  }[]
  backlog: {
    byStatus: Record<EncounterCodingStatus, number>
    byAge: Record<BacklogAgeBucket, number>
    oldestCompletedDate: string | null
  }
}

const COUNTED_ACTIONS = ['claim', 'mark_coded', 'finalise', 'raise_query', 'reopen'] as const

/** IST calendar date of a UTC `timestamp` expression, in SQL. */
const istDateSql = (expr: SQL) =>
  sql`((${expr} AT TIME ZONE 'UTC') AT TIME ZONE ${DEFAULT_TIMEZONE})::date`

const countWhere = (action: (typeof COUNTED_ACTIONS)[number]) =>
  sql<number>`(count(*) filter (where ${encounterCodingEvents.action} = ${action}))::int`

/**
 * Per-actor event counts within the IST date range (inclusive) and the backlog of every completed,
 * not-yet-finalised OPD/IPD visit as of `now`. Actors are grouped by user account (a display name
 * is neither unique nor stable); only events without an account fall back to the name. Grouped
 * queries only; no row lists.
 */
export async function getCodingProductivity(range: { from: string; to: string }, now: Date = new Date()): Promise<CodingProductivity> {
  const [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from]
  const db = getDb()

  const hoursToFinalise = sql`extract(epoch from (${encounterCodingEvents.at} - ${completedAtSql})) / 3600.0`
  const nameKey = sql`case when ${encounterCodingEvents.byUserId} is null then ${encounterCodingEvents.byName} end`
  const perCoderRaw = await db
    .select({
      userId: encounterCodingEvents.byUserId,
      name: sql<string>`(array_agg(${encounterCodingEvents.byName} order by ${encounterCodingEvents.at} desc, ${encounterCodingEvents.id} desc))[1]`,
      claimed: countWhere('claim'),
      coded: countWhere('mark_coded'),
      finalised: countWhere('finalise'),
      queriesRaised: countWhere('raise_query'),
      reopened: countWhere('reopen'),
      median: sql<number | string | null>`percentile_cont(0.5) within group (order by ${hoursToFinalise})
        filter (where ${encounterCodingEvents.action} = 'finalise')`,
    })
    .from(encounterCodingEvents)
    .innerJoin(encounters, eq(encounters.id, encounterCodingEvents.encounterId))
    .where(and(
      inArray(encounterCodingEvents.action, [...COUNTED_ACTIONS]),
      sql`${encounterCodingEvents.at} >= ${instant(startOfIstDay(from))}`,
      sql`${encounterCodingEvents.at} < ${instant(startOfIstDay(addIsoDays(to, 1)))}`,
    ))
    .groupBy(encounterCodingEvents.byUserId, nameKey)

  const perCoder = perCoderRaw
    .map(({ median, ...r }) => ({
      ...r,
      claimed: Number(r.claimed),
      coded: Number(r.coded),
      finalised: Number(r.finalised),
      queriesRaised: Number(r.queriesRaised),
      reopened: Number(r.reopened),
      medianHoursToFinalise: median === null ? null : Math.round(Number(median) * 100) / 100,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.userId ?? 0) - (b.userId ?? 0)))

  // Backlog, grouped by (status, age bucket) in SQL. GROUP BY 1, 2 refers to the output columns,
  // so the parameterised expressions are not repeated.
  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  const ageDays = sql`(${today}::date - ${istDateSql(completedAtSql)})`
  const bucketSql = sql<BacklogAgeBucket>`case
    when ${ageDays} >= 31 then '31+' when ${ageDays} >= 8 then '8-30' when ${ageDays} >= 3 then '3-7' else '0-2' end`
  const backlogRaw = await db
    .select({
      status: codingStatusSql,
      bucket: bucketSql,
      n: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${istDateSql(completedAtSql)})::text`,
    })
    .from(encounters)
    .leftJoin(encounterCoding, eq(encounterCoding.encounterId, encounters.id))
    .where(and(
      eq(encounters.status, 'completed'),
      inArray(encounters.encounterType, [...CODED_ENCOUNTER_TYPES]),
      sql`${codingStatusSql} <> 'finalised'`,
    ))
    .groupBy(sql`1`, sql`2`)

  const byStatus = zeroCounts()
  const byAge = Object.fromEntries(BACKLOG_AGE_BUCKETS.map((b) => [b, 0])) as Record<BacklogAgeBucket, number>
  let oldestCompletedDate: string | null = null
  for (const r of backlogRaw) {
    byStatus[r.status] += Number(r.n)
    byAge[r.bucket] += Number(r.n)
    if (r.oldest !== null && (oldestCompletedDate === null || r.oldest < oldestCompletedDate)) oldestCompletedDate = r.oldest
  }
  return { from, to, perCoder, backlog: { byStatus, byAge, oldestCompletedDate } }
}
