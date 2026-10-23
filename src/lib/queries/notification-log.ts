// Foundations T8: notification_log rows, per-template channel config and per-patient channel
// preferences. The log stores ids, a masked destination, a status and an error class, never a
// message body. Writes that a person makes (template config, preferences) are audited.
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { notificationLog, notificationTemplateConfig, patientNotificationPreferences, patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { DELIVERY_CHANNELS, type DeliveryChannel } from '@/lib/notify/registry'
import { NOTIFICATION_TEMPLATE_KEYS, type NotificationTemplateKey } from '@/lib/notify/templates'
import type { NotificationAttempt, NotificationLogEntry, NotificationStore, PatientChannelPreferences, TemplateChannelConfig } from '@/lib/notify/send'

/** Channels a template uses until an admin saves its row. Email goes only when an address is given. */
export const DEFAULT_TEMPLATE_CHANNELS: readonly DeliveryChannel[] = ['sms', 'whatsapp']

/** Keeps the canonical channel order and drops duplicates/unknowns. */
export function normaliseChannels(channels: readonly string[]): DeliveryChannel[] {
  return DELIVERY_CHANNELS.filter((c) => channels.includes(c))
}

export async function recordNotificationAttempts(rows: NotificationLogEntry[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().insert(notificationLog).values(rows)
}

// Foundations T9: attempts that already went out (or were logged) for this event in the last 24h.
export async function findRecentNotificationAttempts(patientId: string, templateKey: NotificationTemplateKey, dedupeKey: string): Promise<NotificationAttempt[]> {
  const rows = await getDb()
    .select({ channel: notificationLog.channel, status: notificationLog.status })
    .from(notificationLog)
    .where(and(
      eq(notificationLog.patientId, patientId),
      eq(notificationLog.templateKey, templateKey),
      eq(notificationLog.dedupeKey, dedupeKey),
      inArray(notificationLog.status, ['sent', 'log_only']),
      gt(notificationLog.createdAt, sql`now() - interval '24 hours'`),
    ))
    .orderBy(notificationLog.id)
  return rows.map((r) => ({ channel: r.channel, status: r.status as NotificationAttempt['status'] }))
}

/** Foundations T9: what the patient chart's "Recent notices" panel shows. No destination, no text. */
export async function listPatientNotices(patientId: string, limit = 10) {
  return getDb()
    .select({ templateKey: notificationLog.templateKey, channel: notificationLog.channel, status: notificationLog.status, createdAt: notificationLog.createdAt })
    .from(notificationLog)
    .where(eq(notificationLog.patientId, patientId))
    .orderBy(desc(notificationLog.createdAt), desc(notificationLog.id))
    .limit(limit)
}

export async function listRecentNotifications(patientId: string, limit = 10) {
  return getDb()
    .select({
      id: notificationLog.id,
      patientId: notificationLog.patientId,
      templateKey: notificationLog.templateKey,
      channel: notificationLog.channel,
      destinationMasked: notificationLog.destinationMasked,
      status: notificationLog.status,
      providerMessageId: notificationLog.providerMessageId,
      errorClass: notificationLog.errorClass,
      createdAt: notificationLog.createdAt,
    })
    .from(notificationLog)
    .where(eq(notificationLog.patientId, patientId))
    .orderBy(desc(notificationLog.createdAt), desc(notificationLog.id))
    .limit(limit)
}

export interface TemplateConfigView extends TemplateChannelConfig {
  templateKey: NotificationTemplateKey
  saved: boolean
}

export async function listNotificationTemplateConfigs(): Promise<TemplateConfigView[]> {
  const rows = await getDb().select().from(notificationTemplateConfig)
  const byKey = new Map(rows.map((r) => [r.templateKey, r]))
  return NOTIFICATION_TEMPLATE_KEYS.map((templateKey) => {
    const r = byKey.get(templateKey)
    return r
      ? { templateKey, saved: true, channels: normaliseChannels(r.channels), dltTemplateId: r.dltTemplateId, whatsappTemplateName: r.whatsappTemplateName }
      : { templateKey, saved: false, channels: [...DEFAULT_TEMPLATE_CHANNELS], dltTemplateId: null, whatsappTemplateName: null }
  })
}

export async function getNotificationTemplateConfig(templateKey: NotificationTemplateKey): Promise<TemplateChannelConfig> {
  const [r] = await getDb().select().from(notificationTemplateConfig).where(eq(notificationTemplateConfig.templateKey, templateKey))
  if (!r) return { channels: [...DEFAULT_TEMPLATE_CHANNELS], dltTemplateId: null, whatsappTemplateName: null }
  return { channels: normaliseChannels(r.channels), dltTemplateId: r.dltTemplateId, whatsappTemplateName: r.whatsappTemplateName }
}

export async function upsertNotificationTemplateConfig(
  input: { templateKey: NotificationTemplateKey; channels: DeliveryChannel[]; dltTemplateId: string | null; whatsappTemplateName: string | null },
  session: Session,
): Promise<TemplateChannelConfig> {
  const channels = normaliseChannels(input.channels)
  const values = { channels, dltTemplateId: input.dltTemplateId, whatsappTemplateName: input.whatsappTemplateName, updatedByName: session.name }
  return getDb().transaction(async (tx) => {
    await tx
      .insert(notificationTemplateConfig)
      .values({ templateKey: input.templateKey, ...values })
      .onConflictDoUpdate({ target: notificationTemplateConfig.templateKey, set: { ...values, updatedAt: sql`now()` } })
    await logAudit(session, 'changed notification template', null, `template=${input.templateKey} channels=${channels.join(',') || 'none'}`, tx)
    return { channels, dltTemplateId: input.dltTemplateId, whatsappTemplateName: input.whatsappTemplateName }
  })
}

/** null when there is no such patient. No preferences row = every channel on. */
export async function getPatientChannelPreferences(patientId: string): Promise<PatientChannelPreferences | null> {
  const [r] = await getDb()
    .select({
      optOut: patients.notificationOptOut,
      sms: patientNotificationPreferences.sms,
      whatsapp: patientNotificationPreferences.whatsapp,
      email: patientNotificationPreferences.email,
    })
    .from(patients)
    .leftJoin(patientNotificationPreferences, eq(patientNotificationPreferences.patientId, patients.id))
    .where(eq(patients.id, patientId))
  if (!r) return null
  return { optOut: r.optOut, sms: r.sms ?? true, whatsapp: r.whatsapp ?? true, email: r.email ?? true }
}

export type ChannelPreferenceChange = Partial<Record<'sms' | 'whatsapp' | 'email', boolean>>

/** False when there is no such patient. Only the given channels change. */
export async function setPatientChannelPreferences(patientId: string, change: ChannelPreferenceChange, session: Session): Promise<boolean> {
  const set = Object.fromEntries((['sms', 'whatsapp', 'email'] as const).filter((k) => change[k] !== undefined).map((k) => [k, change[k]!])) as ChannelPreferenceChange
  if (Object.keys(set).length === 0) return (await getPatientChannelPreferences(patientId)) !== null
  return getDb().transaction(async (tx) => {
    const [p] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId))
    if (!p) return false
    await tx
      .insert(patientNotificationPreferences)
      .values({ patientId, ...set })
      .onConflictDoUpdate({ target: patientNotificationPreferences.patientId, set: { ...set, updatedAt: sql`now()` } })
    await logAudit(session, 'changed notification channels', patientId, Object.entries(set).map(([k, v]) => `${k}=${v}`).join(' '), tx)
    return true
  })
}

/** The production store for sendNotification. */
export const dbNotificationStore: NotificationStore = {
  templateConfig: getNotificationTemplateConfig,
  patientPreferences: getPatientChannelPreferences,
  record: recordNotificationAttempts,
  findRecentAttempts: findRecentNotificationAttempts,
}
