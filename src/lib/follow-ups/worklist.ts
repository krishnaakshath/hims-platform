// Pure, client-safe recall worklist helpers: search-param parsing, bucket
// filtering, per-bucket sorting and counts.
import type { FollowUpView } from '@/lib/follow-ups/view'

/** The worklist query returns at most this many rows; the page tells the user when the cap is hit. */
export const WORKLIST_ROW_CAP = 500

export const WORKLIST_BUCKETS = ['due', 'overdue', 'upcoming', 'scheduled', 'missed'] as const
export type WorklistBucket = (typeof WORKLIST_BUCKETS)[number]
export type WorklistBucketFilter = WorklistBucket | 'all_open'

export interface WorklistFilters {
  bucket: WorklistBucketFilter
  departmentId: number | null
  providerId: number | null
}

export interface WorklistRow extends Pick<FollowUpView, 'id' | 'status' | 'bucket' | 'dueDate' | 'windowStart' | 'windowEnd' | 'reason' | 'appointment' | 'prescribedBy' | 'department' | 'lastContact'> {
  patientId: string
  patientName: string
  uhid: string | null
  phone: string | null
  contactAttemptCount: number
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function positiveInt(v: string | string[] | undefined): number | null {
  const s = first(v)
  if (s === undefined || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null
}

function isBucket(v: string | undefined): v is WorklistBucketFilter {
  return v === 'all_open' || (WORKLIST_BUCKETS as readonly string[]).includes(v ?? '')
}

export function parseWorklistParams(sp: Record<string, string | string[] | undefined>): WorklistFilters {
  const bucket = first(sp.bucket)
  return {
    bucket: isBucket(bucket) ? bucket : 'due',
    departmentId: positiveInt(sp.departmentId),
    providerId: positiveInt(sp.providerId),
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function compareWithinBucket(bucket: WorklistBucket, a: WorklistRow, b: WorklistRow): number {
  switch (bucket) {
    case 'overdue': return cmp(a.windowEnd, b.windowEnd)
    case 'due': return cmp(a.dueDate, b.dueDate)
    case 'upcoming': return cmp(a.windowStart, b.windowStart)
    case 'scheduled': return (a.appointment?.startsAt.getTime() ?? Infinity) - (b.appointment?.startsAt.getTime() ?? Infinity)
    case 'missed': return cmp(b.windowEnd, a.windowEnd)
  }
}

const isWorklistBucket = (b: FollowUpView['bucket']): b is WorklistBucket => (WORKLIST_BUCKETS as readonly string[]).includes(b)

export function filterAndSortWorklist(rows: WorklistRow[], f: WorklistFilters): WorklistRow[] {
  return rows
    .filter((r) => isWorklistBucket(r.bucket))
    .filter((r) => f.bucket === 'all_open' || r.bucket === f.bucket)
    .filter((r) => f.departmentId === null || r.department?.id === f.departmentId)
    .filter((r) => f.providerId === null || r.prescribedBy.providerId === f.providerId)
    .sort((a, b) => {
      const ab = a.bucket as WorklistBucket
      const bb = b.bucket as WorklistBucket
      return WORKLIST_BUCKETS.indexOf(ab) - WORKLIST_BUCKETS.indexOf(bb) || compareWithinBucket(ab, a, b) || a.id - b.id
    })
}

export function countWorklistBuckets(rows: WorklistRow[]): Record<WorklistBucket, number> {
  const counts: Record<WorklistBucket, number> = { due: 0, overdue: 0, upcoming: 0, scheduled: 0, missed: 0 }
  for (const r of rows) if (isWorklistBucket(r.bucket)) counts[r.bucket] += 1
  return counts
}
