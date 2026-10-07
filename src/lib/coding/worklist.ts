// Coding worklist search params, backlog age buckets and labels (SP6). Pure and client-safe.
import { isoDateSchema } from '@/lib/follow-ups/validation'

export const WORKLIST_STATUS_FILTERS = ['pending', 'uncoded', 'in_progress', 'queried', 'coded', 'finalised'] as const
export const WORKLIST_ASSIGNEE_FILTERS = ['all', 'mine', 'unassigned'] as const
export const WORKLIST_PAGE_SIZE = 50
/** Deep pages are nonsense for a worklist; a larger page param is clamped. */
export const WORKLIST_MAX_PAGE = 10_000

export type WorklistStatusFilter = (typeof WORKLIST_STATUS_FILTERS)[number]
export type WorklistAssigneeFilter = (typeof WORKLIST_ASSIGNEE_FILTERS)[number]

export const WORKLIST_STATUS_FILTER_LABEL: Record<WorklistStatusFilter, string> = {
  pending: 'Not finalised',
  uncoded: 'Not started',
  in_progress: 'In progress',
  queried: 'Query open',
  coded: 'Coded, awaiting finalise',
  finalised: 'Finalised',
}
export const WORKLIST_ASSIGNEE_FILTER_LABEL: Record<WorklistAssigneeFilter, string> = {
  all: 'Everyone',
  mine: 'Claimed by me',
  unassigned: 'Unclaimed',
}

export interface CodingWorklistFilters {
  /** `pending` = every status but finalised. */
  status: WorklistStatusFilter
  assignee: WorklistAssigneeFilter
  encounterType: 'opd' | 'ipd' | null
  departmentId: number | null
  /** Inclusive IST calendar dates of the encounter's completion. */
  fromDate: string | null
  toDate: string | null
  page: number
}

type SearchParams = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)
const oneOf = <T extends string>(values: readonly T[], v: string | undefined): T | null =>
  v !== undefined && (values as readonly string[]).includes(v) ? (v as T) : null
const realDate = (v: string | undefined): string | null => (v !== undefined && isoDateSchema.safeParse(v).success ? v : null)
const positiveInt = (v: string | undefined, max: number): number | null => {
  if (v === undefined || !/^\d{1,10}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= max ? n : null
}

/** Page search params → filters. Anything unknown falls back to the default; never throws. */
export function parseCodingWorklistParams(sp: SearchParams): CodingWorklistFilters {
  let fromDate = realDate(first(sp.from))
  let toDate = realDate(first(sp.to))
  if (fromDate && toDate && fromDate > toDate) [fromDate, toDate] = [toDate, fromDate]
  const page = Math.min(positiveInt(first(sp.page), Number.MAX_SAFE_INTEGER) ?? 1, WORKLIST_MAX_PAGE)
  return {
    status: oneOf(WORKLIST_STATUS_FILTERS, first(sp.status)) ?? 'pending',
    assignee: oneOf(WORKLIST_ASSIGNEE_FILTERS, first(sp.assignee)) ?? 'all',
    encounterType: oneOf(['opd', 'ipd'] as const, first(sp.type)),
    departmentId: positiveInt(first(sp.department), 2_147_483_647),
    fromDate,
    toDate,
    page,
  }
}

export const BACKLOG_AGE_BUCKETS = ['0-2', '3-7', '8-30', '31+'] as const
export type BacklogAgeBucket = (typeof BACKLOG_AGE_BUCKETS)[number]

export const BACKLOG_AGE_LABEL: Record<BacklogAgeBucket, string> = {
  '0-2': '0–2 days',
  '3-7': '3–7 days',
  '8-30': '8–30 days',
  '31+': 'Over 30 days',
}

/** Inclusive lower bounds of each bucket, in whole IST days since completion (SQL mirrors these). */
export const BACKLOG_AGE_MIN_DAYS: Record<BacklogAgeBucket, number> = { '0-2': 0, '3-7': 3, '8-30': 8, '31+': 31 }

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days between two calendar dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
}

/** The backlog age bucket of an encounter completed on `completedIstDate`, as of `todayIso`. */
export function backlogAgeBucket(completedIstDate: string, todayIso: string): BacklogAgeBucket {
  const days = daysBetween(completedIstDate, todayIso)
  if (days >= BACKLOG_AGE_MIN_DAYS['31+']) return '31+'
  if (days >= BACKLOG_AGE_MIN_DAYS['8-30']) return '8-30'
  if (days >= BACKLOG_AGE_MIN_DAYS['3-7']) return '3-7'
  return '0-2'
}

/** The calendar date `days` after `dateIso` (calendar arithmetic only, no clock). */
export function addIsoDays(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}
