// Foundations T8: PUT /api/settings/notification-templates (admin only, strict body, audited).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/queries/notification-log', () => ({
  upsertNotificationTemplateConfig: vi.fn(async (i: { channels: string[]; dltTemplateId: string | null; whatsappTemplateName: string | null }) => ({ channels: i.channels, dltTemplateId: i.dltTemplateId, whatsappTemplateName: i.whatsappTemplateName })),
}))

import { PUT } from '@/app/api/settings/notification-templates/route'
import { upsertNotificationTemplateConfig } from '@/lib/queries/notification-log'

const URL_ = 'http://localhost/api/settings/notification-templates'
const req = (body: unknown) => new NextRequest(URL_, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) })
const GOOD = { templateKey: 'appointment_reminder', channels: ['sms', 'whatsapp'], dltTemplateId: '1107161234567890123', whatsappTemplateName: 'appointment_reminder_v1' }

beforeEach(() => { vi.clearAllMocks(); sessionRole = 'admin' })

describe('PUT /api/settings/notification-templates', () => {
  it('403s every non-admin before parsing', async () => {
    for (const role of ['crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const) {
      sessionRole = role
      const res = await PUT(req('{not json'))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(upsertNotificationTemplateConfig).not.toHaveBeenCalled()
  })

  it('saves a valid row for admin', async () => {
    const res = await PUT(req(GOOD))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, config: { channels: ['sms', 'whatsapp'], dltTemplateId: '1107161234567890123', whatsappTemplateName: 'appointment_reminder_v1' } })
    expect(upsertNotificationTemplateConfig).toHaveBeenCalledWith(GOOD, expect.objectContaining({ role: 'admin' }))
  })

  it('accepts null provider ids and no channels', async () => {
    expect((await PUT(req({ ...GOOD, channels: [], dltTemplateId: null, whatsappTemplateName: null }))).status).toBe(200)
  })

  it.each([
    ['bad JSON', '{not json'],
    ['unknown template', { ...GOOD, templateKey: 'nope' }],
    ['log is not choosable', { ...GOOD, channels: ['log'] }],
    ['duplicate channels', { ...GOOD, channels: ['sms', 'sms'] }],
    ['non-numeric DLT id', { ...GOOD, dltTemplateId: 'abc' }],
    ['bad WhatsApp name', { ...GOOD, whatsappTemplateName: 'Has Spaces' }],
    ['extra key', { ...GOOD, accessToken: 'x' }],
    ['missing key', { templateKey: 'form_sent', channels: [] }],
  ])('400s %s', async (_label, body) => {
    expect((await PUT(req(body))).status).toBe(400)
    expect(upsertNotificationTemplateConfig).not.toHaveBeenCalled()
  })

  it('500s a failed write without leaking the error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(upsertNotificationTemplateConfig).mockRejectedValueOnce(new Error('relation secret'))
    const res = await PUT(req(GOOD))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(JSON.stringify(err.mock.calls)).not.toContain('relation secret')
    err.mockRestore()
  })
})
