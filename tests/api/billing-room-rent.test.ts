import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let role = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: 7 })) }))
vi.mock('@/lib/queries/room-rent', () => ({ postRoomRent: vi.fn() }))

import { POST } from '@/app/api/billing/admissions/[id]/room-rent/route'
import { postRoomRent } from '@/lib/queries/room-rent'

const send = (id: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/billing/admissions/${id}/room-rent`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id }) })

beforeEach(() => {
  role = 'crc'
  vi.mocked(postRoomRent).mockReset().mockResolvedValue({ ok: true, posted: 2, skipped: [{ date: '2099-05-01', reason: 'no_rate' }] })
})

describe('POST /api/billing/admissions/[id]/room-rent', () => {
  it.each(['frontdesk', 'pi', 'pharmacy', 'labs'])('%s is 403 before the body is read', async (r) => {
    role = r
    const res = await send('4', '{not json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(postRoomRent).not.toHaveBeenCalled()
  })

  it('posts with an empty body and returns the counts', async () => {
    const res = await send('4', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posted: 2, skipped: [{ date: '2099-05-01', reason: 'no_rate' }] })
    expect(postRoomRent).toHaveBeenCalledWith(4, expect.objectContaining({ role: 'crc' }), { throughDate: undefined })
  })

  it('passes throughDate; bad body, bad id and bad JSON are 400s', async () => {
    await send('4', { throughDate: '2099-05-02' })
    expect(postRoomRent).toHaveBeenLastCalledWith(4, expect.anything(), { throughDate: '2099-05-02' })
    expect((await send('4', { throughDate: 'tomorrow' })).status).toBe(400)
    expect((await send('x', {})).status).toBe(400)
    const bad = await send('4', '{not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('404 Admission not found; 409 when the room-rent service is not configured', async () => {
    vi.mocked(postRoomRent).mockResolvedValue({ ok: false, error: 'not_found' })
    const nf = await send('4', {})
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'Admission not found' })
    vi.mocked(postRoomRent).mockResolvedValue({ ok: false, error: 'service_not_configured' })
    const nc = await send('4', {})
    expect(nc.status).toBe(409)
    expect(await nc.json()).toEqual({ error: 'Set the room-rent service in Billing rules & settings first' })
  })

  it('a deadlock is a 409 with the retry message', async () => {
    vi.mocked(postRoomRent).mockRejectedValue(Object.assign(new Error('x'), { code: '40P01' }))
    const res = await send('4', {})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Another change was being saved at the same time; please try again' })
  })
})
