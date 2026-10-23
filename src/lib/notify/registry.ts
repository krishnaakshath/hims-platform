// Foundations T8: the notification channel registry. Each adapter reads its credentials from env,
// reports configured() honestly, and returns a typed result (a provider id or an error class,
// never provider text). Nothing here logs a destination, a credential or a message body.
import type { NotificationTemplateKey } from '@/lib/notify/templates'
import { createSmsAdapter } from '@/lib/notify/channels/sms'
import { createEmailAdapter } from '@/lib/notify/channels/email'
import { createWhatsAppAdapter } from '@/lib/notify/channels/whatsapp'
import { createInAppAdapter } from '@/lib/notify/channels/in-app'

export const CHANNELS = ['sms', 'email', 'whatsapp', 'in_app', 'log'] as const
export type Channel = (typeof CHANNELS)[number]
/** The channels an admin can enable per template ('log' is the fallback, never chosen). */
export const DELIVERY_CHANNELS = ['sms', 'whatsapp', 'email', 'in_app'] as const
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number]

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'skipped', 'log_only'] as const
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number]

export interface ChannelMessage {
  patientId: string
  templateKey: NotificationTemplateKey
  /** Rendered PHI-free text (SMS body, email text, in-app text). Never logged. */
  text: string
  /** Ordered template parameters (WhatsApp template body). */
  params: string[]
  subject: string
  /** Normalised phone (+E.164) or email address; for in_app, the patient id. */
  to: string
  dltTemplateId?: string | null
  whatsappTemplateName?: string | null
}

export interface ChannelSendResult {
  ok: boolean
  providerMessageId?: string
  errorClass?: string
}

export interface ChannelAdapter {
  name: Channel
  configured(): boolean
  send(msg: ChannelMessage): Promise<ChannelSendResult>
}

export type ChannelRegistry = Record<DeliveryChannel, ChannelAdapter>

export type Env = Record<string, string | undefined>
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Parses a JSON object of string values from env; anything malformed is an empty map. */
export function envJsonMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0))
  } catch {
    return {}
  }
}

/** HTTP status → error class. Never the provider's response text. */
export function httpErrorClass(status: number): string {
  if (status === 429) return 'rate_limited'
  return `http_${status}`
}

export function getChannelRegistry(opts: { env?: Env; fetch?: FetchLike } = {}): ChannelRegistry {
  const env = opts.env ?? process.env
  return {
    sms: createSmsAdapter({ env, fetch: opts.fetch }),
    whatsapp: createWhatsAppAdapter({ env, fetch: opts.fetch }),
    email: createEmailAdapter({ env }),
    in_app: createInAppAdapter(),
  }
}
