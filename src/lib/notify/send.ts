// Foundations T8: send one patient notice on every channel the template enables.
//
// Per channel, in the template's order:
//   - patient opted out (master notices toggle, or that channel)  → skipped   (adapter not called)
//   - no usable destination for the channel                        → skipped   (no_destination)
//   - adapter not configured (no credentials in env)               → log_only  (never 'sent')
//   - adapter ok / not ok / throws                                 → sent / failed (error class only)
// A template with no channels records a single log_only row on the 'log' channel.
// Every attempt becomes one notification_log row: masked destination, ids and classes, never the
// message body. Throws only if reading the template config or preferences fails (nothing sent);
// a failed log write is reported by error name and does not lose the result.
import { normalizePhone } from '@/lib/india/phone'
import { maskDestination } from '@/lib/notify/notifier'
import { getChannelRegistry, type Channel, type ChannelRegistry, type DeliveryChannel } from '@/lib/notify/registry'
import { notificationSubject, renderNotification, templateParams, type NotificationTemplateKey, type TemplateVars } from '@/lib/notify/templates'
import { dbNotificationStore } from '@/lib/queries/notification-log'

export type { Channel } from '@/lib/notify/registry'

export interface SendNotificationInput {
  patientId: string
  templateKey: NotificationTemplateKey
  vars: unknown
  destination: { phone?: string; email?: string }
}

export type AttemptStatus = 'sent' | 'failed' | 'skipped' | 'log_only'

export interface NotificationAttempt {
  channel: Channel
  status: AttemptStatus
  providerMessageId?: string
}

export interface SendNotificationResult {
  attempts: NotificationAttempt[]
}

export interface NotificationLogEntry {
  patientId: string
  templateKey: NotificationTemplateKey
  channel: Channel
  destinationMasked: string | null
  status: AttemptStatus
  providerMessageId: string | null
  errorClass: string | null
}

export interface TemplateChannelConfig {
  channels: DeliveryChannel[]
  dltTemplateId: string | null
  whatsappTemplateName: string | null
}

export interface PatientChannelPreferences {
  optOut: boolean
  sms: boolean
  whatsapp: boolean
  email: boolean
}

export interface NotificationStore {
  templateConfig(key: NotificationTemplateKey): Promise<TemplateChannelConfig>
  /** null when there is no such patient. */
  patientPreferences(patientId: string): Promise<PatientChannelPreferences | null>
  record(rows: NotificationLogEntry[]): Promise<void>
}

export interface SendNotificationDeps {
  registry?: ChannelRegistry
  store?: NotificationStore
}

function destinationFor(channel: DeliveryChannel, patientId: string, d: SendNotificationInput['destination']): string | null {
  if (channel === 'in_app') return patientId
  if (channel === 'email') {
    const e = d.email?.trim()
    return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
  }
  return d.phone ? normalizePhone(d.phone) : null
}

function optedOut(channel: DeliveryChannel, p: PatientChannelPreferences): boolean {
  if (p.optOut) return true
  return channel === 'in_app' ? false : !p[channel]
}

export async function sendNotification(input: SendNotificationInput, deps: SendNotificationDeps = {}): Promise<SendNotificationResult> {
  const store = deps.store ?? dbNotificationStore
  const registry = deps.registry ?? getChannelRegistry()
  const { patientId, templateKey } = input

  const [config, prefs] = await Promise.all([store.templateConfig(templateKey), store.patientPreferences(patientId)])
  if (!prefs) return { attempts: [] }

  const vars = (input.vars ?? {}) as TemplateVars[typeof templateKey]
  const text = renderNotification(templateKey, vars)
  const params = templateParams(templateKey, vars)
  const hospitalName = String((input.vars as { hospitalName?: unknown } | null)?.hospitalName ?? '')
  const subject = notificationSubject(templateKey, hospitalName)

  const rows: NotificationLogEntry[] = []
  const attempts: NotificationAttempt[] = []
  const push = (channel: Channel, status: AttemptStatus, destinationMasked: string | null, errorClass: string | null, providerMessageId?: string) => {
    rows.push({ patientId, templateKey, channel, destinationMasked, status, providerMessageId: providerMessageId ?? null, errorClass })
    attempts.push(providerMessageId ? { channel, status, providerMessageId } : { channel, status })
  }

  if (config.channels.length === 0) push('log', 'log_only', null, 'no_channels')

  for (const channel of config.channels) {
    if (optedOut(channel, prefs)) { push(channel, 'skipped', null, 'opted_out'); continue }
    const to = destinationFor(channel, patientId, input.destination)
    if (!to) { push(channel, 'skipped', null, 'no_destination'); continue }
    const masked = channel === 'in_app' ? null : maskDestination(to)
    const adapter = registry[channel]
    if (!adapter.configured()) { push(channel, 'log_only', masked, 'not_configured'); continue }
    try {
      const r = await adapter.send({
        patientId, templateKey, text, params, subject, to,
        dltTemplateId: config.dltTemplateId, whatsappTemplateName: config.whatsappTemplateName,
      })
      if (r.ok) push(channel, 'sent', masked, null, r.providerMessageId)
      else push(channel, 'failed', masked, (r.errorClass ?? 'not_delivered').slice(0, 64))
    } catch (err) {
      console.error(`[notify] ${channel} adapter threw (${err instanceof Error ? err.name : typeof err})`)
      push(channel, 'failed', masked, 'exception')
    }
  }

  try {
    await store.record(rows)
  } catch (err) {
    console.error(`[notify] notification log write failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return { attempts }
}
