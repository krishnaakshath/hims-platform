// Foundations T8: channel adapters. Every network/transport is an injected fake; no real calls.
import { describe, it, expect, vi } from 'vitest'
import { createSmsAdapter } from '@/lib/notify/channels/sms'
import { createWhatsAppAdapter } from '@/lib/notify/channels/whatsapp'
import { createEmailAdapter } from '@/lib/notify/channels/email'
import { createInAppAdapter } from '@/lib/notify/channels/in-app'
import { getChannelRegistry, type ChannelMessage } from '@/lib/notify/registry'

const MSG: ChannelMessage = {
  patientId: 'RD-0001',
  templateKey: 'home_collection_booked',
  text: 'City Hospital: Home sample collection booked for 21 Oct 2026, Morning. Our collector will call before arriving.',
  params: ['City Hospital', '21 Oct 2026', 'Morning'],
  subject: 'City Hospital: home sample collection booked',
  to: '+919845013210',
}

const TWILIO = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_FROM_NUMBER: '+15005550006' }
const DLT = { SMS_DLT_SENDER_ID: 'CITYHS', SMS_DLT_TEMPLATE_IDS: JSON.stringify({ home_collection_booked: '1107161234567890123' }) }
const WA = { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: 'wa-secret', WHATSAPP_TEMPLATE_NAMES: JSON.stringify({ home_collection_booked: 'home_collection_booked_v1' }) }
const SMTP = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'noreply@example.test' }

const okJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('SMS adapter (Twilio + DLT)', () => {
  it('is not configured without the Twilio credentials and the DLT sender id', () => {
    expect(createSmsAdapter({ env: {} }).configured()).toBe(false)
    expect(createSmsAdapter({ env: { ...TWILIO } }).configured()).toBe(false)
    expect(createSmsAdapter({ env: { ...TWILIO, ...DLT } }).configured()).toBe(true)
    expect(createSmsAdapter({ env: {} }).name).toBe('sms')
  })

  it('sends with the DLT sender id and the per-template DLT id from env, and returns the provider id', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okJson({ sid: 'SM_abc' }, 201))
    const r = await createSmsAdapter({ env: { ...TWILIO, ...DLT }, fetch }).send(MSG)
    expect(r).toEqual({ ok: true, providerMessageId: 'SM_abc' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
    const form = new URLSearchParams(String(init?.body))
    expect(form.get('From')).toBe('CITYHS')
    expect(form.get('To')).toBe('+919845013210')
    expect(form.get('Body')).toBe(MSG.text)
    expect(form.get('DltTemplateId')).toBe('1107161234567890123')
    expect(form.get('DltEntitySenderId')).toBe('CITYHS')
  })

  it('a configured DLT id on the message wins over the env map', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okJson({ sid: 'SM_x' }, 201))
    await createSmsAdapter({ env: { ...TWILIO, ...DLT }, fetch }).send({ ...MSG, dltTemplateId: '9999' })
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)).get('DltTemplateId')).toBe('9999')
  })

  it('without a DLT template id it fails with a class and never calls the network', async () => {
    const fetch = vi.fn()
    const r = await createSmsAdapter({ env: { ...TWILIO, SMS_DLT_SENDER_ID: 'CITYHS' }, fetch }).send(MSG)
    expect(r).toEqual({ ok: false, errorClass: 'dlt_template_missing' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a provider error is reported as a class only (no provider text, no secrets)', async () => {
    const fetch = vi.fn(async () => new Response('{"message":"secret-token invalid for +919845013210"}', { status: 401 }))
    const r = await createSmsAdapter({ env: { ...TWILIO, ...DLT }, fetch }).send(MSG)
    expect(r).toEqual({ ok: false, errorClass: 'http_401' })
    const thrown = vi.fn(async () => { throw new TypeError('connect ECONNREFUSED') })
    expect(await createSmsAdapter({ env: { ...TWILIO, ...DLT }, fetch: thrown }).send(MSG)).toEqual({ ok: false, errorClass: 'network' })
  })

  it('a malformed SMS_DLT_TEMPLATE_IDS map is treated as empty', async () => {
    const fetch = vi.fn()
    const r = await createSmsAdapter({ env: { ...TWILIO, SMS_DLT_SENDER_ID: 'X', SMS_DLT_TEMPLATE_IDS: '{not json' }, fetch }).send(MSG)
    expect(r.errorClass).toBe('dlt_template_missing')
  })
})

describe('WhatsApp adapter (Meta Cloud API, template messages)', () => {
  it('is configured only with the phone number id and access token', () => {
    expect(createWhatsAppAdapter({ env: {} }).configured()).toBe(false)
    expect(createWhatsAppAdapter({ env: { WHATSAPP_PHONE_NUMBER_ID: '1' } }).configured()).toBe(false)
    expect(createWhatsAppAdapter({ env: WA }).configured()).toBe(true)
  })

  it('sends a template (never free text) with the body params, bearer auth and returns the wamid', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okJson({ messages: [{ id: 'wamid.ABC' }] }))
    const r = await createWhatsAppAdapter({ env: WA, fetch }).send(MSG)
    expect(r).toEqual({ ok: true, providerMessageId: 'wamid.ABC' })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/1234567890\/messages$/)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer wa-secret')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '919845013210',
      type: 'template',
      template: {
        name: 'home_collection_booked_v1',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: MSG.params.map((text) => ({ type: 'text', text })) }],
      },
    })
    expect(body.text).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('Our collector will call')
  })

  it('uses the configured template name on the message over the env map', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okJson({ messages: [{ id: 'w' }] }))
    await createWhatsAppAdapter({ env: WA, fetch }).send({ ...MSG, whatsappTemplateName: 'custom_name' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).template.name).toBe('custom_name')
  })

  it('without a template name it fails with a class and never calls the network', async () => {
    const fetch = vi.fn()
    expect(await createWhatsAppAdapter({ env: { ...WA, WHATSAPP_TEMPLATE_NAMES: '' }, fetch }).send(MSG)).toEqual({ ok: false, errorClass: 'whatsapp_template_missing' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps a 429 to rate_limited and other errors to an http class', async () => {
    expect(await createWhatsAppAdapter({ env: WA, fetch: async () => okJson({ error: { message: 'x' } }, 429) }).send(MSG)).toEqual({ ok: false, errorClass: 'rate_limited' })
    expect(await createWhatsAppAdapter({ env: WA, fetch: async () => okJson({ error: {} }, 400) }).send(MSG)).toEqual({ ok: false, errorClass: 'http_400' })
  })
})

describe('email adapter (SMTP via nodemailer)', () => {
  it('is configured only with every SMTP_* value', () => {
    expect(createEmailAdapter({ env: {} }).configured()).toBe(false)
    expect(createEmailAdapter({ env: { ...SMTP, SMTP_PASSWORD: '' } }).configured()).toBe(false)
    expect(createEmailAdapter({ env: SMTP }).configured()).toBe(true)
  })

  it('sends subject and text through the injected transport and returns the message id', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<m1@example.test>' }))
    const createTransport = vi.fn(() => ({ sendMail }))
    const r = await createEmailAdapter({ env: SMTP, createTransport }).send({ ...MSG, to: 'ravi@example.com' })
    expect(r).toEqual({ ok: true, providerMessageId: '<m1@example.test>' })
    expect(createTransport).toHaveBeenCalledWith({ host: 'smtp.example.test', port: 587, secure: false, auth: { user: 'u', pass: 'p' } })
    expect(sendMail).toHaveBeenCalledWith({ from: 'noreply@example.test', to: 'ravi@example.com', subject: MSG.subject, text: MSG.text })
  })

  it('a transport failure is a class, never the SMTP text', async () => {
    const createTransport = () => ({ sendMail: async () => { throw Object.assign(new Error('535 auth failed for u:p'), { code: 'EAUTH' }) } })
    expect(await createEmailAdapter({ env: SMTP, createTransport }).send({ ...MSG, to: 'a@b.c' })).toEqual({ ok: false, errorClass: 'smtp_eauth' })
  })
})

describe('in-app adapter', () => {
  it('is not configured without an inbox sink (no patient inbox yet), and delivers through one when given', async () => {
    expect(createInAppAdapter().configured()).toBe(false)
    const deliver = vi.fn(async () => ({ id: 'inbox-1' }))
    const a = createInAppAdapter({ deliver })
    expect(a.configured()).toBe(true)
    expect(await a.send(MSG)).toEqual({ ok: true, providerMessageId: 'inbox-1' })
    expect(deliver).toHaveBeenCalledWith({ patientId: 'RD-0001', templateKey: 'home_collection_booked', text: MSG.text })
  })
})

describe('channel registry', () => {
  it('builds every delivery channel from env, honestly unconfigured when env is empty', () => {
    const reg = getChannelRegistry({ env: {} })
    expect(Object.keys(reg).sort()).toEqual(['email', 'in_app', 'sms', 'whatsapp'])
    for (const a of Object.values(reg)) expect(a.configured()).toBe(false)
    const full = getChannelRegistry({ env: { ...TWILIO, ...DLT, ...WA, ...SMTP } })
    expect(full.sms.configured() && full.whatsapp.configured() && full.email.configured()).toBe(true)
  })
})
