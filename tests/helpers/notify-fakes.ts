// Foundations T9: fake configured channel adapters for route tests (real DB, no network).
import { vi } from 'vitest'
import type { ChannelAdapter, ChannelRegistry, DeliveryChannel } from '@/lib/notify/registry'

export function makeFakeRegistry(result: Awaited<ReturnType<ChannelAdapter['send']>> = { ok: true, providerMessageId: 'fake-id' }) {
  const sends = { sms: vi.fn<ChannelAdapter['send']>(async () => result), whatsapp: vi.fn<ChannelAdapter['send']>(async () => result), email: vi.fn<ChannelAdapter['send']>(async () => result), in_app: vi.fn<ChannelAdapter['send']>(async () => result) }
  const adapter = (name: DeliveryChannel) => ({ name, configured: () => true, send: sends[name] })
  const registry = { sms: adapter('sms'), whatsapp: adapter('whatsapp'), email: adapter('email'), in_app: adapter('in_app') } satisfies ChannelRegistry
  return { registry, sends }
}
