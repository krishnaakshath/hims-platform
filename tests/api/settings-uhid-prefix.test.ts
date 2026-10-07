import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/uhid', () => ({ setUhidPrefix: vi.fn(async () => undefined), getUhidPrefix: vi.fn(async () => 'UH') }))

import { PUT } from '@/app/api/settings/uhid-prefix/route'
import { setUhidPrefix } from '@/lib/queries/uhid'
import { logAudit } from '@/lib/audit'

const req = (body: unknown) => new NextRequest('http://localhost/api/settings/uhid-prefix', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => { vi.clearAllMocks(); sessionRole = 'admin' })

describe('PUT /api/settings/uhid-prefix', () => {
  it('403s every non-admin before parsing', async () => {
    for (const role of ['crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'collector'] as const) {
      sessionRole = role
      const res = await PUT(new NextRequest('http://localhost/api/settings/uhid-prefix', { method: 'PUT', body: 'not json' }))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(setUhidPrefix).not.toHaveBeenCalled()
  })
  it('400s an invalid prefix', async () => {
    const res = await PUT(req({ prefix: 'uh-1' }))
    expect(res.status).toBe(400)
    expect(setUhidPrefix).not.toHaveBeenCalled()
  })
  it('400s extra keys', async () => {
    expect((await PUT(req({ prefix: 'MH', x: 1 }))).status).toBe(400)
  })
  it('500s a failed write, logging only the pg code and constraint', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(setUhidPrefix).mockRejectedValueOnce({ code: '23514', constraint: 'uhid_prefix_check', detail: 'secret' })
    const res = await PUT(req({ prefix: 'MH01' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not update UHID prefix' })
    expect(JSON.stringify(spy.mock.calls)).toContain('23514')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret')
    expect(logAudit).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('saves a valid prefix and audits', async () => {
    const res = await PUT(req({ prefix: 'MH01' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, prefix: 'MH01' })
    expect(setUhidPrefix).toHaveBeenCalledWith('MH01')
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'changed UHID prefix', null)
  })
})
