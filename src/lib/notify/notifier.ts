// SP5 notification channel. Channel-agnostic: callers hand over the rendered text and a
// destination; the notifier reports which channel it used and whether it delivered.
import type { NotificationTemplateKey } from '@/lib/notify/templates'
import { getChannelRegistry, type ChannelRegistry } from '@/lib/notify/registry' // Foundations T8

export interface OutboundNotification {
  patientId: string
  templateKey: NotificationTemplateKey
  text: string
  destination: string
}

export interface NotifierResult {
  channel: 'log' | 'sms' | 'whatsapp' | 'email'
  delivered: boolean
  errorCode?: string
}

export interface Notifier {
  send(msg: OutboundNotification): Promise<NotifierResult>
}

/**
 * `+919845013210` → `+91******3210`: keeps the `+91` prefix (or a bare `+`) and the last 4 digits.
 * Foundations T8: an email keeps its first character and the domain (`r*********@example.com`).
 */
export function maskDestination(phone: string): string {
  const at = phone.lastIndexOf('@')
  if (at > 0) return phone[0] + '*'.repeat(at - 1) + phone.slice(at)
  const prefix = phone.startsWith('+91') ? '+91' : phone.startsWith('+') ? '+' : ''
  const rest = phone.slice(prefix.length)
  if (rest.length <= 4) return prefix + '*'.repeat(rest.length)
  return prefix + '*'.repeat(rest.length - 4) + rest.slice(-4)
}

/** Log-only channel: one line of ids and a masked number. Never the text. Nothing is delivered. */
export function createLogOnlyNotifier(log: (line: string) => void = console.info): Notifier {
  return {
    async send(msg) {
      log(`[notify] template=${msg.templateKey} patient=${msg.patientId} to=${maskDestination(msg.destination)} channel=log delivered=false`)
      return { channel: 'log', delivered: false }
    },
  }
}

// Foundations T8: the notifier is backed by the channel registry. For the existing SP5 callers
// (one phone destination) it uses SMS when the SMS adapter is configured (Twilio + DLT), else
// it stays log-only and the delivery log says so (status 'logged', never 'sent'). New callers
// use sendNotification (src/lib/notify/send.ts), which routes per template and logs each attempt.
export function createRegistryNotifier(registry: ChannelRegistry, log: (line: string) => void = console.info): Notifier {
  const fallback = createLogOnlyNotifier(log)
  return {
    async send(msg) {
      const sms = registry.sms
      if (!sms.configured() || msg.destination.includes('@')) return fallback.send(msg)
      const r = await sms.send({ patientId: msg.patientId, templateKey: msg.templateKey, text: msg.text, params: [], subject: '', to: msg.destination })
      return r.ok ? { channel: 'sms', delivered: true } : { channel: 'sms', delivered: false, errorCode: r.errorClass ?? 'not_delivered' }
    },
  }
}

export function getNotifier(): Notifier {
  return createRegistryNotifier(getChannelRegistry())
}
