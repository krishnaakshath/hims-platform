// SP5 patient notifications and the opt-out flag. Callers notify only AFTER their clinical write
// has committed, through notifyPatientSafely, which never throws. Foundations T9: delivery goes
// through sendNotification (channel config, per-patient opt-out, adapters, notification_log with
// a masked destination and no message text, dedupe by the request's key).
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { NotificationTemplateKey, TemplateVars } from '@/lib/notify/templates'
import { sendNotification, type SendNotificationDeps, type SendNotificationResult } from '@/lib/notify/send'
import { getPatientChannelPreferences } from '@/lib/queries/notification-log'

export interface NotifyPatientRequest<K extends NotificationTemplateKey> {
  patientId: string
  templateKey: K
  vars: TemplateVars[K]
  related: { type: 'lab_requisition' | 'home_collection_visit' | 'lab_report'; id: number }
  dedupeKey: string
}

export type NotifyOutcome = 'logged' | 'sent' | 'failed' | 'suppressed_opt_out' | 'skipped_no_contact' | 'duplicate'

/** Phone and email the notification service may use for this patient (null when no such patient). */
async function patientContact(patientId: string): Promise<{ phone?: string; email?: string } | null> {
  const [p] = await getDb().select({ phone: patients.phone, email: patients.email }).from(patients).where(eq(patients.id, patientId))
  if (!p) return null
  return { ...(p.phone ? { phone: p.phone } : {}), ...(p.email ? { email: p.email } : {}) }
}

interface PatientNoticeRequest<K extends NotificationTemplateKey> { patientId: string; templateKey: K; vars: TemplateVars[K]; dedupeKey: string }

/**
 * Foundations T9: the one place staff-triggered patient notices go through. Loads the patient's
 * contact details and hands over to sendNotification (channel config, opt-out, adapters, log,
 * dedupe by key). Never throws: a failure is reported by error name only and returns null, so a
 * notice can never fail the primary action. `vars` must never carry a token or link.
 */
export async function sendPatientNotice<K extends NotificationTemplateKey>(
  reqOrBuild: PatientNoticeRequest<K> | (() => PatientNoticeRequest<K>),
  deps?: SendNotificationDeps,
): Promise<SendNotificationResult | null> {
  try {
    // A builder runs inside the try, so computing vars (dates, labels) can never throw into the caller.
    const req = typeof reqOrBuild === 'function' ? reqOrBuild() : reqOrBuild
    const destination = (await patientContact(req.patientId)) ?? {}
    return await sendNotification({ patientId: req.patientId, templateKey: req.templateKey, vars: req.vars, destination, dedupeKey: req.dedupeKey }, deps)
  } catch (err) {
    console.error('[notify] failed', err instanceof Error ? err.name : 'error')
    return null
  }
}

function outcomeOf(r: SendNotificationResult): NotifyOutcome {
  if (r.deduped) return 'duplicate'
  const has = (s: string) => r.attempts.some((a) => a.status === s)
  if (has('sent')) return 'sent'
  if (has('failed')) return 'failed'
  if (has('log_only')) return 'logged'
  return 'skipped_no_contact'
}

/**
 * One SP5 notice through sendNotification. Throws only if the notification service itself
 * cannot read its config; a channel failure is recorded in notification_log as 'failed'.
 */
export async function notifyPatient<K extends NotificationTemplateKey>(
  _actorName: string,
  req: NotifyPatientRequest<K>,
  deps?: SendNotificationDeps,
): Promise<NotifyOutcome> {
  const destination = await patientContact(req.patientId)
  if (!destination) return 'skipped_no_contact'
  const r = await sendNotification({ patientId: req.patientId, templateKey: req.templateKey, vars: req.vars, destination, dedupeKey: req.dedupeKey }, deps)
  // Only the master opt-out is checked here; per-channel opt-outs report as skipped_no_contact.
  const suppressed = r.attempts.length > 0 && !r.deduped && r.attempts.every((a) => a.status === 'skipped') && (await optedOutEverywhere(req.patientId))
  return suppressed ? 'suppressed_opt_out' : outcomeOf(r)
}

async function optedOutEverywhere(patientId: string): Promise<boolean> {
  const p = await getPatientChannelPreferences(patientId)
  return !!p && p.optOut
}

/**
 * Runs after the caller's change has committed. Never throws, so a notice can never fail a
 * clinical write. Audits the outcome (ids and codes only). On a failure it logs only the
 * error's name.
 */
export async function notifyPatientSafely<K extends NotificationTemplateKey>(
  session: Session,
  req: NotifyPatientRequest<K>,
  deps?: SendNotificationDeps,
): Promise<NotifyOutcome | 'error'> {
  let outcome: NotifyOutcome
  try {
    outcome = await notifyPatient(session.name, req, deps)
  } catch (err) {
    console.error('[notify] failed', err instanceof Error ? err.name : 'error')
    return 'error'
  }
  try {
    await logAudit(session, 'patient notification', req.patientId, `template=${req.templateKey} outcome=${outcome} related=${req.related.type}:${req.related.id}`)
  } catch (err) {
    console.error('[notify] audit failed', err instanceof Error ? err.name : 'error')
  }
  return outcome
}

/** False when there is no such patient. Opting out again keeps the original opt-out time. */
export async function setNotificationOptOut(patientId: string, optOut: boolean, session: Session): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(patients)
      .set({
        notificationOptOut: optOut,
        notificationOptOutAt: optOut ? sql`coalesce(${patients.notificationOptOutAt}, now())` : null,
      })
      .where(eq(patients.id, patientId))
      .returning({ id: patients.id })
    if (!row) return false
    await logAudit(session, 'changed notification preference', patientId, `optOut=${optOut}`, tx)
    return true
  })
}
