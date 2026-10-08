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

/** `+919845013210` → `+91******3210`: keeps the `+91` prefix (or a bare `+`) and the last 4 digits. */
export function maskDestination(phone: string): string {
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

// A real SMS/WhatsApp provider is chosen here per deployment, behind an explicit env
// credential (spec §3 "No fake data"): until one is configured, every notice is log-only and
// the delivery log says so (status 'logged', never 'sent').
export function getNotifier(): Notifier {
  return createLogOnlyNotifier()
}
