import type { AppointmentStatus } from '@/lib/queries/appointments'

const CONFIG: Record<AppointmentStatus, { label: string; dotClassName: string; textClassName: string }> = {
  scheduled: { label: 'Scheduled', dotClassName: 'bg-primary', textClassName: 'text-foreground' },
  completed: { label: 'Completed', dotClassName: 'bg-success', textClassName: 'text-success' },
  cancelled: { label: 'Cancelled', dotClassName: 'bg-muted-foreground', textClassName: 'text-muted-foreground' },
  no_show: { label: 'No-Show', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
}

export function AppointmentStatusChip({ status }: { status: AppointmentStatus }) {
  const { label, dotClassName, textClassName } = CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}
