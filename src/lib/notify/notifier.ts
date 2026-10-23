// SP5 notification channel. Channel-agnostic: callers hand over the rendered text and a
// destination; the notifier reports which channel it used and whether it delivered.
import type { NotificationTemplateKey } from '@/lib/notify/templates'

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

// Legacy SP5 notifier: always log-only. It cannot apply per-channel preferences or the
// per-template config, so it must never reach a real channel (spec §4.4). Real sending goes only
// through sendNotification (src/lib/notify/send.ts); Task 9 moves the SP5 callers onto it.
export function getNotifier(): Notifier {
  return createLogOnlyNotifier()
}
