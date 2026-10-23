// Foundations T8: sendNotification routing, opt-out, honest fallback. Pure: fake adapters and an in-memory store.
import { describe, it, expect, vi } from 'vitest'
import { sendNotification, type NotificationStore, type NotificationLogEntry } from '@/lib/notify/send'
import type { ChannelAdapter, ChannelRegistry, DeliveryChannel } from '@/lib/notify/registry'

function fakeAdapter(name: DeliveryChannel, configured = true, result: Awaited<ReturnType<ChannelAdapter['send']>> = { ok: true, providerMessageId: `${name}-id` }) {
  return { name, configured: () => configured, send: vi.fn<ChannelAdapter['send']>(async () => result) }
}

function fakeRegistry(over: Partial<Record<DeliveryChannel, ReturnType<typeof fakeAdapter>>> = {}) {
  return {
    sms: over.sms ?? fakeAdapter('sms'),
    email: over.email ?? fakeAdapter('email'),
    whatsapp: over.whatsapp ?? fakeAdapter('whatsapp'),
    in_app: over.in_app ?? fakeAdapter('in_app'),
  } satisfies ChannelRegistry
}

function fakeStore(opts: { channels?: DeliveryChannel[]; prefs?: Partial<{ optOut: boolean; sms: boolean; whatsapp: boolean; email: boolean }> | null; dlt?: string | null; wa?: string | null } = {}) {
  const rows: NotificationLogEntry[] = []
  const store: NotificationStore = {
    templateConfig: async () => ({ channels: opts.channels ?? ['sms', 'email', 'whatsapp', 'in_app'], dltTemplateId: opts.dlt ?? null, whatsappTemplateName: opts.wa ?? null }),
    patientPreferences: async () => (opts.prefs === null ? null : { optOut: false, sms: true, whatsapp: true, email: true, ...opts.prefs }),
    record: async (r) => { rows.push(...r) },
  }
  return { store, rows }
}

const INPUT = {
  patientId: 'RD-0001',
  templateKey: 'home_collection_booked' as const,
  vars: { hospitalName: 'City Hospital', visitDate: '2026-10-21', windowLabel: 'Morning', patientName: 'Ravi Kumar', testName: 'HbA1c' },
  destination: { phone: '98450 13210', email: 'ravi.kumar@example.com' },
}

describe('sendNotification', () => {
  it('routes to every channel enabled for the template and configured, and logs one row per attempt', async () => {
    const registry = fakeRegistry()
    const { store, rows } = fakeStore({ channels: ['sms', 'whatsapp'] })
    const r = await sendNotification(INPUT, { registry, store })
    expect(r.attempts).toEqual([
      { channel: 'sms', status: 'sent', providerMessageId: 'sms-id' },
      { channel: 'whatsapp', status: 'sent', providerMessageId: 'whatsapp-id' },
    ])
    expect(registry.email.send).not.toHaveBeenCalled()
    expect(registry.in_app.send).not.toHaveBeenCalled()
    expect(registry.sms.send).toHaveBeenCalledWith(expect.objectContaining({ to: '+919845013210', templateKey: 'home_collection_booked', params: ['City Hospital', '21 Oct 2026', 'Morning'] }))
    expect(rows).toEqual([
      { patientId: 'RD-0001', templateKey: 'home_collection_booked', channel: 'sms', destinationMasked: '+91******3210', status: 'sent', providerMessageId: 'sms-id', errorClass: null },
      { patientId: 'RD-0001', templateKey: 'home_collection_booked', channel: 'whatsapp', destinationMasked: '+91******3210', status: 'sent', providerMessageId: 'whatsapp-id', errorClass: null },
    ])
  })

  it('passes the configured DLT id and WhatsApp template name to the adapters', async () => {
    const registry = fakeRegistry()
    const { store } = fakeStore({ channels: ['sms', 'whatsapp'], dlt: '1107', wa: 'booked_v2' })
    await sendNotification(INPUT, { registry, store })
    expect(registry.sms.send).toHaveBeenCalledWith(expect.objectContaining({ dltTemplateId: '1107' }))
    expect(registry.whatsapp.send).toHaveBeenCalledWith(expect.objectContaining({ whatsappTemplateName: 'booked_v2' }))
  })

  it('an unconfigured channel records log_only (never sent) and the adapter is not called', async () => {
    const registry = fakeRegistry({ sms: fakeAdapter('sms', false), email: fakeAdapter('email', false) })
    const { store, rows } = fakeStore({ channels: ['sms', 'email'] })
    const r = await sendNotification(INPUT, { registry, store })
    expect(r.attempts).toEqual([{ channel: 'sms', status: 'log_only' }, { channel: 'email', status: 'log_only' }])
    expect(registry.sms.send).not.toHaveBeenCalled()
    expect(registry.email.send).not.toHaveBeenCalled()
    expect(rows.map((x) => [x.channel, x.status, x.errorClass])).toEqual([['sms', 'log_only', 'not_configured'], ['email', 'log_only', 'not_configured']])
    expect(rows[1].destinationMasked).toBe('r*********@example.com')
  })

  it('an opted-out channel records skipped and its adapter is never called', async () => {
    const registry = fakeRegistry()
    const { store, rows } = fakeStore({ channels: ['sms', 'whatsapp', 'email'], prefs: { whatsapp: false, email: false } })
    const r = await sendNotification(INPUT, { registry, store })
    expect(r.attempts).toEqual([
      { channel: 'sms', status: 'sent', providerMessageId: 'sms-id' },
      { channel: 'whatsapp', status: 'skipped' },
      { channel: 'email', status: 'skipped' },
    ])
    expect(registry.whatsapp.send).not.toHaveBeenCalled()
    expect(registry.email.send).not.toHaveBeenCalled()
    expect(rows.filter((x) => x.status === 'skipped').map((x) => x.errorClass)).toEqual(['opted_out', 'opted_out'])
  })

  it('the master notices opt-out skips every channel, in-app included', async () => {
    const registry = fakeRegistry()
    const { store } = fakeStore({ prefs: { optOut: true } })
    const r = await sendNotification(INPUT, { registry, store })
    expect(r.attempts.map((a) => a.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped'])
    for (const a of Object.values(registry)) expect(a.send).not.toHaveBeenCalled()
  })

  it('an unknown patient sends nothing', async () => {
    const registry = fakeRegistry()
    const { store, rows } = fakeStore({ prefs: null })
    const r = await sendNotification(INPUT, { registry, store })
    expect(r.attempts).toEqual([])
    expect(rows).toEqual([])
    for (const a of Object.values(registry)) expect(a.send).not.toHaveBeenCalled()
  })

  it('a channel without a destination is skipped as no_destination', async () => {
    const registry = fakeRegistry()
    const { store, rows } = fakeStore({ channels: ['sms', 'email', 'in_app'] })
    const r = await sendNotification({ ...INPUT, destination: { phone: 'not-a-phone' } }, { registry, store })
    expect(r.attempts).toEqual([{ channel: 'sms', status: 'skipped' }, { channel: 'email', status: 'skipped' }, { channel: 'in_app', status: 'sent', providerMessageId: 'in_app-id' }])
    expect(rows.slice(0, 2).map((x) => [x.errorClass, x.destinationMasked])).toEqual([['no_destination', null], ['no_destination', null]])
    expect(registry.sms.send).not.toHaveBeenCalled()
  })

  it('an adapter failure records failed with only the error class; a throw is failed/exception', async () => {
    const registry = fakeRegistry({
      sms: fakeAdapter('sms', true, { ok: false, errorClass: 'http_401' }),
      whatsapp: { name: 'whatsapp', configured: () => true, send: vi.fn<ChannelAdapter['send']>(async () => { throw new Error('token wa-secret leaked +919845013210') }) },
    })
    const { store, rows } = fakeStore({ channels: ['sms', 'whatsapp'] })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await sendNotification(INPUT, { registry, store })
    expect(r.attempts).toEqual([{ channel: 'sms', status: 'failed' }, { channel: 'whatsapp', status: 'failed' }])
    expect(rows.map((x) => x.errorClass)).toEqual(['http_401', 'exception'])
    expect(JSON.stringify(rows)).not.toContain('wa-secret')
    expect(JSON.stringify(err.mock.calls)).not.toContain('wa-secret')
    err.mockRestore()
  })

  it('a template with no channels records one log-only row on the log channel', async () => {
    const { store, rows } = fakeStore({ channels: [] })
    const r = await sendNotification(INPUT, { registry: fakeRegistry(), store })
    expect(r.attempts).toEqual([{ channel: 'log', status: 'log_only' }])
    expect(rows[0]).toMatchObject({ channel: 'log', status: 'log_only', destinationMasked: null })
  })

  it('PHI rule: no log row and no adapter message carries the patient name, test name or body text', async () => {
    const registry = fakeRegistry()
    const { store, rows } = fakeStore()
    await sendNotification(INPUT, { registry, store })
    const sent = JSON.stringify([registry.sms.send.mock.calls, registry.whatsapp.send.mock.calls, registry.email.send.mock.calls])
    for (const bad of ['Ravi Kumar', 'HbA1c']) expect(sent).not.toContain(bad)
    const logged = JSON.stringify(rows)
    for (const bad of ['Ravi', 'HbA1c', 'Home sample collection', '9845013210']) expect(logged).not.toContain(bad)
  })

  it('a failed log write does not lose the result', async () => {
    const { store } = fakeStore({ channels: ['sms'] })
    store.record = async () => { throw new Error('db down') }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await sendNotification(INPUT, { registry: fakeRegistry(), store })
    expect(r.attempts).toEqual([{ channel: 'sms', status: 'sent', providerMessageId: 'sms-id' }])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
