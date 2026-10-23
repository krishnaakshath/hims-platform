// Foundations T9: the patient chart's "Recent notices" panel. Template, channel, status and time
// only -- never a destination or a message body. Server-renderable (no client state).
import { formatIstDateTime } from '@/lib/india-time'

export interface NoticeItem { templateKey: string; channel: string; status: string; createdAt: string }

const TEMPLATE_LABEL: Record<string, string> = {
  lab_tests_ordered: 'Lab tests ordered',
  home_collection_booked: 'Home collection booked',
  home_collection_rescheduled: 'Home collection moved',
  home_collection_cancelled: 'Home collection cancelled',
  lab_report_ready: 'Lab report ready',
  form_sent: 'Form sent',
  video_visit_link: 'Video visit',
  booking_confirmed: 'Booking confirmed',
  appointment_reminder: 'Appointment reminder',
}
const CHANNEL_LABEL: Record<string, string> = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', in_app: 'In-app', log: 'Log only' }
const STATUS_LABEL: Record<string, string> = { sent: 'Sent', failed: 'Failed', skipped: 'Skipped', log_only: 'Not delivered (log only)', queued: 'Queued' }

export function RecentNoticesPanel({ items }: { items: NoticeItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No notices have been sent to this patient yet.</p>
  return (
    <ul className="divide-y divide-border text-sm" aria-label="Recent notices">
      {items.map((n, i) => (
        <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
          <span className="font-medium text-foreground">{TEMPLATE_LABEL[n.templateKey] ?? n.templateKey}</span>
          <span className="text-muted-foreground">{CHANNEL_LABEL[n.channel] ?? n.channel} · {STATUS_LABEL[n.status] ?? n.status} · {formatIstDateTime(n.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
}
