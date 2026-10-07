import type { FollowUpStatus, RecallBucket } from '@/lib/follow-ups/rules'
import { FOLLOW_UP_STATUS_LABEL } from '@/lib/follow-ups/rules'

const TONE: Record<string, string> = {
  planned: 'bg-secondary text-secondary-foreground',
  due: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  upcoming: 'bg-secondary text-secondary-foreground',
  overdue: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  scheduled: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  missed: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

/** Text is always shown, never colour alone. A not-yet-booked order says how urgent it is. */
export function FollowUpStatusChip({ status, bucket }: { status: FollowUpStatus; bucket?: RecallBucket }) {
  const key = status === 'planned' && (bucket === 'due' || bucket === 'overdue' || bucket === 'upcoming') ? bucket : status
  const label = key === 'due' ? 'Due' : key === 'overdue' ? 'Overdue' : key === 'upcoming' ? 'Upcoming' : FOLLOW_UP_STATUS_LABEL[status]
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[key]}`}>{label}</span>
}
