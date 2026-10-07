// Encounter coding status as a coloured, labelled badge (the label carries the meaning, not the colour).
import { CODING_STATUS_LABEL, type EncounterCodingStatus } from '@/lib/coding/status'

const TONE: Record<EncounterCodingStatus, string> = {
  uncoded: 'border-border bg-muted text-foreground',
  in_progress: 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
  queried: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
  coded: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-100',
  finalised: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
}

export function CodingStatusBadge({ status }: { status: EncounterCodingStatus }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>
      {CODING_STATUS_LABEL[status]}
    </span>
  )
}
