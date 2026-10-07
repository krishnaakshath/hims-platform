import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: null })) }))
vi.mock('@/lib/queries/encounters', () => ({ transitionEncounter: vi.fn() }))

import { POST } from '@/app/api/encounters/[id]/status/route'
import { transitionEncounter } from '@/lib/queries/encounters'

const send = (body: unknown) => new NextRequest('http://localhost/api/encounters/3/status', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const ENCOUNTER = { id: 3, status: 'completed' }

beforeEach(() => {
  role = 'frontdesk'
  vi.mocked(transitionEncounter).mockReset()
  vi.mocked(transitionEncounter).mockResolvedValue({ ok: true, encounter: ENCOUNTER as never })
})

describe('POST /api/encounters/[id]/status', () => {
  it('frontdesk may cancel but not complete', async () => {
    role = 'frontdesk'
    expect((await POST(send({ to: 'completed' }), ctx('3'))).status).toBe(403)
    expect(transitionEncounter).not.toHaveBeenCalled()
    const res = await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ encounter: ENCOUNTER })
    expect(transitionEncounter).toHaveBeenCalledWith(3, 'cancelled', expect.objectContaining({ role: 'frontdesk' }), { cancelReason: 'left' })
  })

  it('pi may start and complete a consultation but not cancel', async () => {
    role = 'pi'
    expect((await POST(send({ to: 'in_consultation' }), ctx('3'))).status).toBe(200)
    expect((await POST(send({ to: 'completed' }), ctx('3'))).status).toBe(200)
    const denied = await POST(send({ to: 'cancelled', cancelReason: 'x' }), ctx('3'))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
  })

  it('maps invalid_transition to 409 and not_found to 404', async () => {
    role = 'admin'
    vi.mocked(transitionEncounter).mockResolvedValueOnce({ ok: false, error: 'invalid_transition' })
    const conflict = await POST(send({ to: 'completed' }), ctx('3'))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'This visit can no longer change to that status.' })
    vi.mocked(transitionEncounter).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    const missing = await POST(send({ to: 'completed' }), ctx('3'))
    expect(missing.status).toBe(404)
  })

  it('403s a role outside the gate before parsing the body', async () => {
    for (const r of ['billing', 'labs', 'pharmacy']) {
      role = r
      const res = await POST(send('{not json'), ctx('3'))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
  })

  it('400s bad JSON, a bad payload and a bad id without echoing input', async () => {
    const bad = await POST(send('{not json'), ctx('3'))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Invalid JSON' })
    const noReason = await POST(send({ to: 'cancelled' }), ctx('3'))
    expect(noReason.status).toBe(400)
    const unknown = await POST(send({ to: 'teleported-SECRET' }), ctx('3'))
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).not.toContain('SECRET')
    for (const id of ['abc', '0', '-1', '1.5', '99999999999']) {
      const res = await POST(send({ to: 'cancelled', cancelReason: 'x' }), ctx(id))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid encounter id' })
    }
    expect(transitionEncounter).not.toHaveBeenCalled()
  })

  it('a thrown error is a generic 500', async () => {
    vi.mocked(transitionEncounter).mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '40P01' }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not update the visit' })
    expect(spy.mock.calls.flat().join(' ')).toContain('40P01')
    expect(spy.mock.calls.flat().join(' ')).not.toContain('left')
    spy.mockRestore()
  })
})
