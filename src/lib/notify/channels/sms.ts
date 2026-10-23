// Foundations T8: SMS through Twilio with India DLT. Reuses the OTP Twilio credentials
// (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) and sends from the DLT-registered header
// SMS_DLT_SENDER_ID with the per-template DLT id (template config, else SMS_DLT_TEMPLATE_IDS).
// A message with no DLT template id is never sent (Indian operators drop it anyway).
import { envJsonMap, httpErrorClass, type ChannelAdapter, type Env, type FetchLike } from '@/lib/notify/registry'

export function createSmsAdapter(opts: { env?: Env; fetch?: FetchLike } = {}): ChannelAdapter {
  const env = opts.env ?? process.env
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const sid = () => env.TWILIO_ACCOUNT_SID
  const token = () => env.TWILIO_AUTH_TOKEN
  const sender = () => env.SMS_DLT_SENDER_ID

  return {
    name: 'sms',
    configured: () => Boolean(sid() && token() && sender()),
    async send(msg) {
      const accountSid = sid(), authToken = token(), senderId = sender()
      if (!accountSid || !authToken || !senderId) return { ok: false, errorClass: 'not_configured' }
      const dltTemplateId = msg.dltTemplateId || envJsonMap(env.SMS_DLT_TEMPLATE_IDS)[msg.templateKey]
      if (!dltTemplateId) return { ok: false, errorClass: 'dlt_template_missing' }

      // DLT ids travel as named fields next to the sender header; the provider account maps them
      // to the operator's DLT scrubbing (see the report: confirm field names with the provider).
      const body = new URLSearchParams({
        To: msg.to,
        From: senderId,
        Body: msg.text,
        DltEntitySenderId: senderId,
        DltTemplateId: dltTemplateId,
      })
      let res: Response
      try {
        res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          },
          body: body.toString(),
        })
      } catch {
        return { ok: false, errorClass: 'network' }
      }
      if (!res.ok) return { ok: false, errorClass: httpErrorClass(res.status) }
      const data = (await res.json().catch(() => null)) as { sid?: unknown } | null
      return typeof data?.sid === 'string' ? { ok: true, providerMessageId: data.sid } : { ok: true }
    },
  }
}
