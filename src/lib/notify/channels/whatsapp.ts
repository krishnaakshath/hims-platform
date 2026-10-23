// Foundations T8: WhatsApp Cloud API (Meta). Business-initiated messages must be approved
// templates, so this adapter only ever sends a template (name from template config, else
// WHATSAPP_TEMPLATE_NAMES) with the ordered body parameters -- never free text.
import { envJsonMap, httpErrorClass, type ChannelAdapter, type Env, type FetchLike } from '@/lib/notify/registry'

const GRAPH_VERSION = 'v21.0'

export function createWhatsAppAdapter(opts: { env?: Env; fetch?: FetchLike } = {}): ChannelAdapter {
  const env = opts.env ?? process.env
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))

  return {
    name: 'whatsapp',
    configured: () => Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN),
    async send(msg) {
      const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID, accessToken = env.WHATSAPP_ACCESS_TOKEN
      if (!phoneNumberId || !accessToken) return { ok: false, errorClass: 'not_configured' }
      const templateName = msg.whatsappTemplateName || envJsonMap(env.WHATSAPP_TEMPLATE_NAMES)[msg.templateKey]
      if (!templateName) return { ok: false, errorClass: 'whatsapp_template_missing' }

      const payload = {
        messaging_product: 'whatsapp',
        to: msg.to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en' },
          components: [{ type: 'body', parameters: msg.params.map((text) => ({ type: 'text', text })) }],
        },
      }
      let res: Response
      try {
        res = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(payload),
        })
      } catch {
        return { ok: false, errorClass: 'network' }
      }
      if (!res.ok) return { ok: false, errorClass: httpErrorClass(res.status) }
      const data = (await res.json().catch(() => null)) as { messages?: { id?: unknown }[] } | null
      const id = data?.messages?.[0]?.id
      return typeof id === 'string' ? { ok: true, providerMessageId: id } : { ok: true }
    },
  }
}
