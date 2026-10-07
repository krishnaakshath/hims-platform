import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'

export type FollowUpNoticeKind = 'planned' | 'plan_changed' | 'booked' | 'rescheduled' | 'unbooked' | 'cancelled'

export interface FollowUpNotice {
  kind: FollowUpNoticeKind
  followUpOrderId: number
  patientId: string
  dueDate: string
  appointmentStartsAt: Date | null
}

export interface FollowUpNotifyResult { channel: 'log'; delivered: false }

export interface FollowUpNotifier {
  notify(notice: FollowUpNotice): Promise<FollowUpNotifyResult>
}

/** Log-only notifier: ids and dates only (no name, phone, reason or notes). Nothing is delivered. */
export function createLogOnlyFollowUpNotifier(log: (line: string) => void = console.info): FollowUpNotifier {
  return {
    async notify(n) {
      const appt = n.appointmentStartsAt ? n.appointmentStartsAt.toISOString() : 'none'
      log(`[follow-up notice] kind=${n.kind} order=${n.followUpOrderId} patient=${n.patientId} due=${n.dueDate} appt=${appt} channel=log delivered=false`)
      return { channel: 'log', delivered: false }
    },
  }
}

// SP5 swaps in the real channels from src/lib/notify here.
export function getFollowUpNotifier(): FollowUpNotifier {
  return createLogOnlyFollowUpNotifier()
}

/** Runs after the change has committed. Never throws: a notice failure must not fail a committed change. */
export async function notifyFollowUpSafely(
  session: Session,
  notice: FollowUpNotice,
  notifier: FollowUpNotifier = getFollowUpNotifier(),
): Promise<void> {
  try {
    await notifier.notify(notice)
    await logAudit(session, 'follow-up notice (log only)', notice.patientId, `followUp=${notice.followUpOrderId} kind=${notice.kind} delivered=false`)
  } catch (err) {
    console.error('[follow-up notice] failed', err instanceof Error ? err.name : 'error')
  }
}
