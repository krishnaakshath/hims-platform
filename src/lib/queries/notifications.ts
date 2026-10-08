// SP5 patient notifications: the delivery log, the dedupe key and the opt-out flag. Callers
// notify only AFTER their clinical write has committed, through notifyPatientSafely, which
// never throws. Each attempt writes one notification_deliveries row (masked destination, no
// message text).
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { notificationDeliveries, patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { normalizePhone } from '@/lib/india/phone'
import { renderNotification, type NotificationTemplateKey, type TemplateVars } from '@/lib/notify/templates'
import { getNotifier, maskDestination, type Notifier, type NotifierResult } from '@/lib/notify/notifier'

export interface NotifyPatientRequest<K extends NotificationTemplateKey> {
  patientId: string
  templateKey: K
  vars: TemplateVars[K]
  related: { type: 'lab_requisition' | 'home_collection_visit' | 'lab_report'; id: number }
  dedupeKey: string
}

export type NotifyOutcome = 'logged' | 'sent' | 'failed' | 'suppressed_opt_out' | 'skipped_no_contact' | 'duplicate'

type DeliveryUpdate = Partial<Pick<typeof notificationDeliveries.$inferInsert, 'status' | 'channel' | 'destinationMasked' | 'errorCode'>>

/**
 * One notice: claim the dedupe key with a 'logged' row first (a retried request finds it and
 * stops), then decide (opt-out, no reachable phone) and send. The delivery row ends in the
 * outcome. Throws only if the DB itself fails; a notifier error is recorded as 'failed'.
 */
export async function notifyPatient<K extends NotificationTemplateKey>(
  actorName: string,
  req: NotifyPatientRequest<K>,
  notifier: Notifier = getNotifier(),
): Promise<NotifyOutcome> {
  const db = getDb()
  const [claimed] = await db
    .insert(notificationDeliveries)
    .values({
      patientId: req.patientId,
      templateKey: req.templateKey,
      channel: 'log',
      status: 'logged',
      relatedType: req.related.type,
      relatedId: req.related.id,
      dedupeKey: req.dedupeKey,
      createdByName: actorName,
    })
    .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
    .returning({ id: notificationDeliveries.id })
  if (!claimed) return 'duplicate'

  const finish = async (outcome: Exclude<NotifyOutcome, 'duplicate'>, set: DeliveryUpdate = {}): Promise<NotifyOutcome> => {
    await db.update(notificationDeliveries).set({ status: outcome, ...set }).where(eq(notificationDeliveries.id, claimed.id))
    return outcome
  }

  const [patient] = await db
    .select({ phone: patients.phone, notificationOptOut: patients.notificationOptOut })
    .from(patients)
    .where(eq(patients.id, req.patientId))
  if (!patient) return finish('skipped_no_contact')
  if (patient.notificationOptOut) return finish('suppressed_opt_out')
  const destination = patient.phone ? normalizePhone(patient.phone) : null
  if (!destination) return finish('skipped_no_contact')

  const destinationMasked = maskDestination(destination)
  const text = renderNotification(req.templateKey, req.vars)
  let result: NotifierResult
  try {
    result = await notifier.send({ patientId: req.patientId, templateKey: req.templateKey, text, destination })
  } catch {
    return finish('failed', { destinationMasked, errorCode: 'exception' })
  }
  if (result.delivered) return finish('sent', { channel: result.channel, destinationMasked })
  if (result.errorCode) return finish('failed', { channel: result.channel, destinationMasked, errorCode: result.errorCode.slice(0, 64) })
  if (result.channel === 'log') return finish('logged', { channel: 'log', destinationMasked })
  return finish('failed', { channel: result.channel, destinationMasked, errorCode: 'not_delivered' })
}

/**
 * Runs after the caller's change has committed. Never throws, so a notice can never fail a
 * clinical write. Audits the outcome (ids and codes only). On a failure it logs only the
 * error's name.
 */
export async function notifyPatientSafely<K extends NotificationTemplateKey>(
  session: Session,
  req: NotifyPatientRequest<K>,
  notifier?: Notifier,
): Promise<NotifyOutcome | 'error'> {
  let outcome: NotifyOutcome
  try {
    outcome = await notifyPatient(session.name, req, notifier)
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
