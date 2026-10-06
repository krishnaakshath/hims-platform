import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'

type AssignmentStatus = DoctorAssignmentRow['status']

// Single source of truth for doctor-assignment status display, shared by
// FrontDeskDashboard and the /front-desk/assignments page -- both used to
// define their own STATUS_LABEL/STATUS_COLOR maps with divergent "declined"
// wording. "Declined — needs reassignment" is kept as the canonical label
// since it's the more useful one for the reader.
// Status is always a colored dot + plain text label, never color alone --
// same convention as StatusChip.tsx.
const CONFIG: Record<AssignmentStatus, { label: string; dotClassName: string; textClassName: string }> = {
  pending: { label: 'Pending', dotClassName: 'bg-warning', textClassName: 'text-warning' },
  scheduled: { label: 'Scheduled', dotClassName: 'bg-success', textClassName: 'text-success' },
  declined: { label: 'Declined — needs reassignment', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
}

export function AssignmentStatusChip({ status, declineReason }: { status: AssignmentStatus; declineReason?: string | null }) {
  const { label, dotClassName, textClassName } = CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}{status === 'declined' && declineReason ? ` (${declineReason})` : ''}
    </span>
  )
}
