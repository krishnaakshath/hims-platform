import type { PortalFollowUp } from '@/lib/follow-ups/view'
import { PORTAL_FOLLOW_UP_LABEL } from '@/lib/follow-ups/rules'
import { formatIsoDate, formatIstDateTime } from './format'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** Server-safe. Dates, status and doctor only: PortalFollowUp carries no reason or notes, and none is read here. */
export function PortalFollowUpCard({ followUp }: { followUp: PortalFollowUp }) {
  const booked = followUp.status === 'scheduled' && followUp.appointmentStartsAt !== null
  return (
    <section className={SECTION} aria-labelledby="portal-follow-up-heading">
      <h2 id="portal-follow-up-heading" className={HEADING}>Your follow-up</h2>
      <p className="text-sm font-medium text-foreground">{PORTAL_FOLLOW_UP_LABEL[followUp.status]}</p>
      <p className="text-xs text-muted-foreground">
        {booked
          ? `${formatIstDateTime(followUp.appointmentStartsAt!)} with ${followUp.doctorName ?? 'your doctor'}`
          : `Please visit between ${formatIsoDate(followUp.windowStart)} and ${formatIsoDate(followUp.windowEnd)}`}
      </p>
      {followUp.status === 'missed' && <p className="mt-1 text-xs text-muted-foreground">Please call the hospital to rebook.</p>}
    </section>
  )
}
