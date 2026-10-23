// Foundations T9: sendNotification dedupe and per-template vars validation. Pure: fake adapters and store.
import { describe, it, expect, vi } from 'vitest'
import { sendNotification, type NotificationStore, type NotificationLogEntry, type NotificationAttempt } from '@/lib/notify/send'
import type { ChannelAdapter, ChannelRegistry, DeliveryChannel } from '@/lib/notify/registry'

const adapter = (name: DeliveryChannel) => ({ name, configured: () => true, send: vi.fn<ChannelAdapter['send']>(async () => ({ ok: true, providerMessageId: `${name}-id` })) })
const registry = () => ({ sms: adapter('sms'), email: adapter('email'), whatsapp: adapter('whatsapp'), in_app: adapter('in_app') }) satisfies ChannelRegistry

function store(prior: NotificationAttempt[] = []) {
  const rows: NotificationLogEntry[] = []
  const lookups: unknown[] = []
  const s: NotificationStore = {
    templateConfig: async () => ({ channels: ['sms', 'whatsapp'], dltTemplateId: null, whatsappTemplateName: null }),
    patientPreferences: async () => ({ optOut: false, sms: true, whatsapp: true, email: true }),
    record: async (r) => { rows.push(...r) },
    findRecentAttempts: async (patientId, templateKey, dedupeKey) => { lookups.push([patientId, templateKey, dedupeKey]); return prior },
  }
  return { s, rows, lookups }
}

const INPUT = { patientId: 'RD-0001', templateKey: 'form_sent' as const, vars: { hospitalName: 'City Hospital' }, destination: { phone: '9845013210' } }

describe('sendNotification dedupe', () => {
  it('a prior sent/log_only attempt for the same key returns skipped attempts and calls no adapter', async () => {
    const reg = registry()
    const { s, rows, lookups } = store([{ channel: 'sms', status: 'sent', providerMessageId: 'x' }, { channel: 'whatsapp', status: 'log_only' }])
    const r = await sendNotification({ ...INPUT, dedupeKey: 'form:7' }, { registry: reg, store: s })
    expect(r.attempts).toEqual([{ channel: 'sms', status: 'skipped' }, { channel: 'whatsapp', status: 'skipped' }])
    expect(r.deduped).toBe(true)
    expect(lookups).toEqual([['RD-0001', 'form_sent', 'form:7']])
    expect(reg.sms.send).not.toHaveBeenCalled()
    expect(reg.whatsapp.send).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('no prior attempt sends and stores the key on every row', async () => {
    const reg = registry()
    const { s, rows } = store([])
    const r = await sendNotification({ ...INPUT, dedupeKey: 'form:8' }, { registry: reg, store: s })
    expect(r.deduped).toBeFalsy()
    expect(reg.sms.send).toHaveBeenCalledTimes(1)
    expect(rows.map((x) => x.dedupeKey)).toEqual(['form:8', 'form:8'])
  })

  it('without a dedupeKey nothing is looked up', async () => {
    const { s, lookups } = store([{ channel: 'sms', status: 'sent' }])
    const r = await sendNotification(INPUT, { registry: registry(), store: s })
    expect(lookups).toEqual([])
    expect(r.attempts.map((a) => a.status)).toEqual(['sent', 'sent'])
  })
})

describe('sendNotification vars validation', () => {
  it('missing vars record one failed invalid_vars row and call no adapter', async () => {
    const reg = registry()
    const { s, rows } = store()
    const r = await sendNotification({ ...INPUT, templateKey: 'video_visit_link', vars: { hospitalName: 'City Hospital' } }, { registry: reg, store: s })
    expect(r.attempts).toEqual([{ channel: 'log', status: 'failed' }])
    expect(rows).toEqual([expect.objectContaining({ channel: 'log', status: 'failed', errorClass: 'invalid_vars', destinationMasked: null })])
    expect(reg.sms.send).not.toHaveBeenCalled()
  })

  it('null vars and a malformed date also fail without throwing', async () => {
    const { s, rows } = store()
    await expect(sendNotification({ ...INPUT, vars: null }, { registry: registry(), store: s })).resolves.toMatchObject({ attempts: [{ status: 'failed' }] })
    await sendNotification({ ...INPUT, templateKey: 'booking_confirmed', vars: { hospitalName: 'H', visitDate: 'tomorrow', timeLabel: '10:00' } }, { registry: registry(), store: s })
    expect(rows.map((x) => x.errorClass)).toEqual(['invalid_vars', 'invalid_vars'])
  })
})
