// Foundations T8: email over SMTP with nodemailer, the same SMTP_* settings as the OTP sender
// (src/lib/email.ts). A transport failure is reported by its nodemailer code only.
import nodemailer from 'nodemailer'
import type { ChannelAdapter, Env } from '@/lib/notify/registry'

interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: unknown }>
}
type TransportOptions = { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }
type CreateTransport = (o: TransportOptions) => MailTransport

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const

export function createEmailAdapter(opts: { env?: Env; createTransport?: CreateTransport } = {}): ChannelAdapter {
  const env = opts.env ?? process.env
  const createTransport: CreateTransport = opts.createTransport ?? ((o) => nodemailer.createTransport(o) as unknown as MailTransport)

  return {
    name: 'email',
    configured: () => KEYS.every((k) => Boolean(env[k])),
    async send(msg) {
      if (!KEYS.every((k) => Boolean(env[k]))) return { ok: false, errorClass: 'not_configured' }
      const port = Number(env.SMTP_PORT)
      try {
        const transport = createTransport({ host: env.SMTP_HOST!, port, secure: port === 465, auth: { user: env.SMTP_USER!, pass: env.SMTP_PASSWORD! } })
        const info = await transport.sendMail({ from: env.SMTP_FROM!, to: msg.to, subject: msg.subject, text: msg.text })
        return typeof info?.messageId === 'string' ? { ok: true, providerMessageId: info.messageId } : { ok: true }
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' && /^[A-Z_]{2,32}$/.test(err.code) ? err.code : null
        return { ok: false, errorClass: code ? `smtp_${code.toLowerCase()}` : 'smtp_error' }
      }
    },
  }
}
