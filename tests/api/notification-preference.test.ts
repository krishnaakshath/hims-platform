import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'frontdesk'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'Probe Desk', userId: 3 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/notifications', () => ({ setNotificationOptOut: vi.fn() }))
vi.mock('@/lib/queries/notification-log', () => ({ setPatientChannelPreferences: vi.fn() })) // Foundations T8
vi.mock('@/lib/cache', () => ({ invalidateCache: vi.fn(async () => undefined), patientDetailCacheKey: (id: string) => `patient:${id}` }))

import { PUT } from '@/app/api/patients/[anonId]/notification-preference/route'
import { setNotificationOptOut } from '@/lib/queries/notifications'
import { setPatientChannelPreferences } from '@/lib/queries/notification-log' // Foundations T8
import { invalidateCache } from '@/lib/cache'

const put = (body: unknown, anonId = 'RD-0001') =>
  PUT(new NextRequest(`http://localhost/api/patients/${anonId}/notification-preference`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ anonId }) })

beforeEach(() => {
  role = 'frontdesk'
  signedIn = true
  vi.mocked(setNotificationOptOut).mockReset().mockResolvedValue(true)
  vi.mocked(setPatientChannelPreferences).mockReset().mockResolvedValue(true)
  vi.mocked(invalidateCache).mockClear()
})

describe('PUT /api/patients/[anonId]/notification-preference', () => {
  it('frontdesk can opt a patient out; pi gets 403 before parse', async () => {
    const ok = await put({ optOut: true })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ optOut: true })
    expect(setNotificationOptOut).toHaveBeenCalledWith('RD-0001', true, expect.objectContaining({ role: 'frontdesk' }))
    expect(invalidateCache).toHaveBeenCalledWith('patient:RD-0001')

    vi.mocked(setNotificationOptOut).mockClear()
    role = 'pi'
    const denied = await put('{not json')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
    expect(setNotificationOptOut).not.toHaveBeenCalled()
  })

  it.each(['labs', 'billing', 'pharmacy', 'collector'] as const)('%s is denied before parse', async (r) => {
    role = r
    expect((await put('{not json')).status).toBe(403)
    expect(setNotificationOptOut).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    signedIn = false
    expect((await put({ optOut: true })).status).toBe(401)
  })

  it('400s bad JSON and bad bodies', async () => {
    expect((await put('{not json')).status).toBe(400)
    expect((await put({ optOut: 'yes' })).status).toBe(400)
    expect((await put({ optOut: true, phone: '9845013210' })).status).toBe(400)
    expect(setNotificationOptOut).not.toHaveBeenCalled()
  })

  it('404s an unknown patient', async () => {
    vi.mocked(setNotificationOptOut).mockResolvedValueOnce(false)
    const res = await put({ optOut: false })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Patient not found' })
  })

  it('a cache failure does not fail the saved change', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(invalidateCache).mockRejectedValueOnce(new Error('redis down'))
    expect((await put({ optOut: true })).status).toBe(200)
    err.mockRestore()
  })

  it('409s a deadlock; 500s anything else without the message', async () => {
    vi.mocked(setNotificationOptOut).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40001' }))
    expect((await put({ optOut: true })).status).toBe(409)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(setNotificationOptOut).mockRejectedValueOnce(new Error('secret RD-0001'))
    const res = await put({ optOut: true })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(err.mock.calls.flat().join(' ')).not.toContain('secret')
    err.mockRestore()
  })

  // Foundations T8: per-channel preferences (SMS, WhatsApp, email) next to the master toggle.
  it('saves channel preferences only, without touching the master opt-out', async () => {
    const res = await put({ whatsapp: false, email: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ whatsapp: false, email: true })
    expect(setPatientChannelPreferences).toHaveBeenCalledWith('RD-0001', { whatsapp: false, email: true }, expect.objectContaining({ role: 'frontdesk' }))
    expect(setNotificationOptOut).not.toHaveBeenCalled()
  })

  it('saves the master toggle and a channel together', async () => {
    expect((await put({ optOut: false, sms: false })).status).toBe(200)
    expect(setNotificationOptOut).toHaveBeenCalledWith('RD-0001', false, expect.anything())
    expect(setPatientChannelPreferences).toHaveBeenCalledWith('RD-0001', { sms: false }, expect.anything())
  })

  it('400s an empty body or a non-boolean channel; 404s an unknown patient on a channel change', async () => {
    expect((await put({})).status).toBe(400)
    expect((await put({ sms: 'no' })).status).toBe(400)
    expect((await put({ in_app: false })).status).toBe(400)
    vi.mocked(setPatientChannelPreferences).mockResolvedValueOnce(false)
    expect((await put({ sms: false })).status).toBe(404)
  })
})
