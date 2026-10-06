type Urgency = 'routine' | 'urgent' | 'emergency'

// Urgency is always a colored dot + plain text label, never color alone --
// same convention as AssignmentStatusChip.tsx.
const CONFIG: Record<Urgency, { label: string; dotClassName: string; textClassName: string }> = {
  routine: { label: 'Routine', dotClassName: 'bg-muted-foreground', textClassName: 'text-muted-foreground' },
  urgent: { label: 'Urgent', dotClassName: 'bg-warning', textClassName: 'text-warning' },
  emergency: { label: 'Emergency', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
}

export function AssignmentUrgencyChip({ urgency }: { urgency: Urgency }) {
  const { label, dotClassName, textClassName } = CONFIG[urgency]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}
