import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/providers', () => ({ updateProviderProfile: vi.fn(), getProviderById: vi.fn() }))
vi.mock('@/lib/queries/departments', () => ({ getDepartmentById: vi.fn() }))

import { updateProviderProfile, getProviderById } from '@/lib/queries/providers'
import { getDepartmentById } from '@/lib/queries/departments'
import { logAudit } from '@/lib/audit'
import { PUT } from '@/app/api/providers/[id]/route'

const req = (body: unknown) =>
  new NextRequest('http://localhost/api/providers/7', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id = '7') => ({ params: Promise.resolve({ id }) })
const row = { id: 7, name: 'Dr A', consultationFeePaise: 30000 }

beforeEach(() => {
  sessionRole = 'admin'
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(getProviderById).mockResolvedValue(row as never)
  vi.mocked(updateProviderProfile).mockResolvedValue(row as never)
  vi.mocked(getDepartmentById).mockResolvedValue({ id: 3 } as never)
})

describe('PUT /api/providers/[id]', () => {
  it('403 body is exactly {error:"Forbidden"} for non-admin, before parsing', async () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'admin')) {
      sessionRole = role
      const res = await PUT(req('{not json'), ctx())
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(updateProviderProfile).not.toHaveBeenCalled()
  })
  it('400s an unknown departmentId', async () => {
    vi.mocked(getDepartmentById).mockResolvedValue(null)
    const res = await PUT(req({ departmentId: 999 }), ctx())
    expect(res.status).toBe(400)
    expect(updateProviderProfile).not.toHaveBeenCalled()
  })
  it('400s a bad payload and non-integer id; 404s unknown provider', async () => {
    expect((await PUT(req({}), ctx())).status).toBe(400)
    expect((await PUT(req('{not json'), ctx())).status).toBe(400)
    expect((await PUT(req({ name: 'X' }), ctx('abc'))).status).toBe(400)
    vi.mocked(getProviderById).mockResolvedValue(null as never)
    expect((await PUT(req({ name: 'X' }), ctx())).status).toBe(404)
  })
  it('audits the profile update with action text only', async () => {
    const res = await PUT(req({ name: 'Dr B', registrationCouncil: 'nmc', registrationNumber: '12345' }), ctx())
    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledTimes(1)
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'updated provider profile', null)
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls)).not.toContain('12345')
  })
  it('400s an inactive department', async () => {
    vi.mocked(getDepartmentById).mockResolvedValue({ id: 3, isActive: false } as never)
    expect((await PUT(req({ departmentId: 3 }), ctx())).status).toBe(400)
    expect(updateProviderProfile).not.toHaveBeenCalled()
  })
  it('allows clearing the department even if it is inactive, and does not look it up', async () => {
    expect((await PUT(req({ departmentId: null }), ctx())).status).toBe(200)
    expect(getDepartmentById).not.toHaveBeenCalled()
  })
  it('accepts a state alone when the stored council is SMC, rejects it otherwise', async () => {
    vi.mocked(getProviderById).mockResolvedValue({ ...row, registrationCouncil: 'smc', registrationStateCode: 'IN-KA' } as never)
    expect((await PUT(req({ registrationStateCode: 'IN-MH' }), ctx())).status).toBe(200)
    expect(updateProviderProfile).toHaveBeenCalledWith(7, { registrationStateCode: 'IN-MH' })
    expect((await PUT(req({ registrationStateCode: null }), ctx())).status).toBe(400)
    vi.mocked(getProviderById).mockResolvedValue({ ...row, registrationCouncil: 'nmc', registrationStateCode: null } as never)
    expect((await PUT(req({ registrationStateCode: 'IN-MH' }), ctx())).status).toBe(400)
    vi.mocked(getProviderById).mockResolvedValue({ ...row, registrationCouncil: null, registrationStateCode: null } as never)
    expect((await PUT(req({ registrationStateCode: 'IN-MH' }), ctx())).status).toBe(400)
  })
  it('audits a cleared fee as none, not ₹0.00', async () => {
    await PUT(req({ consultationFeePaise: null }), ctx())
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'changed provider consultation fee', null, '₹300.00 → none')
    vi.mocked(getProviderById).mockResolvedValue({ ...row, consultationFeePaise: null } as never)
    await PUT(req({ consultationFeePaise: 0 }), ctx())
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'changed provider consultation fee', null, 'none → ₹0.00')
  })
  it('audits a fee change with old and new amounts', async () => {
    await PUT(req({ consultationFeePaise: 50000 }), ctx())
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'changed provider consultation fee', null, '₹300.00 → ₹500.00')
  })
  it('does not audit a fee change when the fee is unchanged', async () => {
    await PUT(req({ consultationFeePaise: 30000 }), ctx())
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'changed provider consultation fee', null, expect.anything())
  })
  it('409s a unique violation and 500s others logging only pg code', async () => {
    vi.mocked(updateProviderProfile).mockRejectedValueOnce({ code: '23505', constraint: 'x', detail: 'secret 12345' })
    expect((await PUT(req({ name: 'X' }), ctx())).status).toBe(409)
    vi.mocked(updateProviderProfile).mockRejectedValueOnce({ code: '23514', detail: 'secret 12345' })
    expect((await PUT(req({ name: 'X' }), ctx())).status).toBe(500)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('12345')
  })
})
