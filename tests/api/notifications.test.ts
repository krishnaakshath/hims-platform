// Wave G P2-01: GET /api/notifications and POST /api/notifications/read.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role | null = 'frontdesk'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (sessionRole ? { role: sessionRole, name: `Test ${sessionRole}`, userId: null } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
const getStaffFeed = vi.fn()
const markStaffNotificationsRead = vi.fn()
vi.mock('@/lib/queries/staff-notifications', () => ({
  getStaffFeed: (...a: unknown[]) => getStaffFeed(...a),
  markStaffNotificationsRead: (...a: unknown[]) => markStaffNotificationsRead(...a),
}))

import { GET } from '@/app/api/notifications/route'
import { POST } from '@/app/api/notifications/read/route'

const FEED = { items: [{ key: 'booking_request:1', kind: 'booking_request', title: 'New appointment request', detail: 'x', href: '/booking-requests', occurredAt: '2026-10-08T04:00:00.000Z', severity: 'info', read: false }], unreadCount: 1 }
const post = (body: string) => POST(new NextRequest('http://localhost/api/notifications/read', { method: 'POST', body, headers: { 'content-type': 'application/json' } }))

afterEach(() => { sessionRole = 'frontdesk'; getStaffFeed.mockReset(); markStaffNotificationsRead.mockReset() })

describe('GET /api/notifications', () => {
  it('401s without a session', async () => {
    sessionRole = null
    expect((await GET()).status).toBe(401)
  })

  it('returns the feed and unread count, not cached', async () => {
    getStaffFeed.mockResolvedValue(FEED)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(FEED)
    expect(getStaffFeed).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }))
  })

  it('answers a fixed 500 (no internals) when the feed fails', async () => {
    getStaffFeed.mockRejectedValue(new Error('relation "x" does not exist'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not load notifications' })
  })
})

describe('POST /api/notifications/read', () => {
  it('marks the given keys read and returns the new feed', async () => {
    markStaffNotificationsRead.mockResolvedValue({ ...FEED, unreadCount: 0 })
    const res = await post(JSON.stringify({ keys: ['booking_request:1'] }))
    expect(res.status).toBe(200)
    expect((await res.json()).unreadCount).toBe(0)
    expect(markStaffNotificationsRead).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), ['booking_request:1'])
  })

  it('marks everything read with { all: true }', async () => {
    markStaffNotificationsRead.mockResolvedValue({ ...FEED, unreadCount: 0 })
    expect((await post(JSON.stringify({ all: true }))).status).toBe(200)
    expect(markStaffNotificationsRead).toHaveBeenCalledWith(expect.anything(), null)
  })

  it.each([
    ['not JSON', '{nope', 'Invalid JSON'],
    ['empty keys', JSON.stringify({ keys: [] }), 'Invalid request'],
    ['malformed key', JSON.stringify({ keys: ["x'; drop"] }), 'Invalid request'],
    ['too many keys', JSON.stringify({ keys: Array.from({ length: 101 }, (_, i) => `lab_report:${i}`) }), 'Invalid request'],
    ['unknown field', JSON.stringify({ keys: ['lab_report:1'], userKey: 'u:1' }), 'Invalid request'],
    ['all false', JSON.stringify({ all: false }), 'Invalid request'],
  ])('400s %s without writing', async (_n, body, error) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(markStaffNotificationsRead).not.toHaveBeenCalled()
  })
})
