// Foundations T8: in-app (patient portal) notices. There is no patient inbox store yet, so by
// default this channel is not configured and every in-app attempt is recorded as log_only.
// A later task wires a real inbox by passing `deliver`.
import type { ChannelAdapter } from '@/lib/notify/registry'
import type { NotificationTemplateKey } from '@/lib/notify/templates'

type Deliver = (m: { patientId: string; templateKey: NotificationTemplateKey; text: string }) => Promise<{ id: string }>

export function createInAppAdapter(opts: { deliver?: Deliver } = {}): ChannelAdapter {
  const deliver = opts.deliver
  return {
    name: 'in_app',
    configured: () => Boolean(deliver),
    async send(msg) {
      if (!deliver) return { ok: false, errorClass: 'not_configured' }
      try {
        const { id } = await deliver({ patientId: msg.patientId, templateKey: msg.templateKey, text: msg.text })
        return { ok: true, providerMessageId: id }
      } catch {
        return { ok: false, errorClass: 'inbox_error' }
      }
    },
  }
}
