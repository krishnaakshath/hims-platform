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
vi.mock('@/lib/queries/departments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/departments')>('@/lib/queries/departments')
  return { ...actual, listDepartments: vi.fn(), createDepartment: vi.fn(), updateDepartment: vi.fn(), getDepartmentById: vi.fn() }
})

import { listDepartments, createDepartment, updateDepartment } from '@/lib/queries/departments'
import { logAudit } from '@/lib/audit'
import { GET, POST } from '@/app/api/departments/route'
import { PATCH } from '@/app/api/departments/[id]/route'

const req = (method: string, body?: unknown, path = '/api/departments') =>
  new NextRequest(`http://localhost${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const dept = { id: 5, code: 'CARD', name: 'Cardiology', kind: 'clinical', isActive: true, createdAt: new Date() }

beforeEach(() => {
  sessionRole = 'admin'
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('/api/departments', () => {
  it('GET admits every staff role', async () => {
    vi.mocked(listDepartments).mockResolvedValue([dept] as never)
    for (const role of ALL_ROLES) {
      sessionRole = role
      const res = await GET(req('GET'))
      expect(res.status).toBe(200)
    }
  })
  it('GET ?active=1 asks for active only', async () => {
    vi.mocked(listDepartments).mockResolvedValue([])
    await GET(new NextRequest('http://localhost/api/departments?active=1'))
    expect(listDepartments).toHaveBeenCalledWith({ activeOnly: true })
  })
  it('POST 403s every non-admin before parsing', async () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'admin')) {
      sessionRole = role
      const res = await POST(req('POST', '{not json'))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(createDepartment).not.toHaveBeenCalled()
  })
  it('POST upper-cases and validates the code', async () => {
    vi.mocked(createDepartment).mockResolvedValue(dept as never)
    const ok = await POST(req('POST', { code: 'card', name: 'Cardiology', kind: 'clinical' }))
    expect(ok.status).toBe(201)
    expect(createDepartment).toHaveBeenCalledWith({ code: 'CARD', name: 'Cardiology', kind: 'clinical' })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'created department CARD', null)
    const bad = await POST(req('POST', { code: '1X', name: 'X', kind: 'clinical' }))
    expect(bad.status).toBe(400)
  })
  it('POST rejects unknown keys', async () => {
    const res = await POST(req('POST', { code: 'CARD', name: 'C', kind: 'clinical', isActive: false }))
    expect(res.status).toBe(400)
  })
  it('POST maps departments_code_unique to 409', async () => {
    vi.mocked(createDepartment).mockRejectedValue(Object.assign(new Error('x'), { cause: { code: '23505', constraint: 'departments_code_unique' } }))
    const res = await POST(req('POST', { code: 'CARD', name: 'Cardiology', kind: 'clinical' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Department code already exists' })
  })
  it('POST 500 logs only pg code/constraint', async () => {
    vi.mocked(createDepartment).mockRejectedValue(Object.assign(new Error('secret detail'), { cause: { code: '22001' } }))
    const res = await POST(req('POST', { code: 'CARD', name: 'Cardiology', kind: 'clinical' }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret detail')
  })
})

describe('/api/departments/[id]', () => {
  it('PATCH 403s non-admins before parsing', async () => {
    sessionRole = 'pi'
    const res = await PATCH(req('PATCH', '{not json'), ctx('5'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })
  it('PATCH rejects a code change (strict) and an empty body', async () => {
    expect((await PATCH(req('PATCH', { code: 'NEW' }), ctx('5'))).status).toBe(400)
    expect((await PATCH(req('PATCH', {}), ctx('5'))).status).toBe(400)
  })
  it('PATCH 400s a non-integer id and 404s an unknown one', async () => {
    expect((await PATCH(req('PATCH', { name: 'X' }), ctx('abc'))).status).toBe(400)
    vi.mocked(updateDepartment).mockResolvedValue(null)
    expect((await PATCH(req('PATCH', { name: 'X' }), ctx('99'))).status).toBe(404)
  })
  it('PATCH audits update vs deactivation', async () => {
    vi.mocked(updateDepartment).mockResolvedValue({ ...dept, isActive: false } as never)
    await PATCH(req('PATCH', { isActive: false }), ctx('5'))
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), 'deactivated department CARD', null)
    vi.mocked(updateDepartment).mockResolvedValue(dept as never)
    const res = await PATCH(req('PATCH', { name: 'Cardiac' }), ctx('5'))
    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), 'updated department CARD', null)
  })
})
