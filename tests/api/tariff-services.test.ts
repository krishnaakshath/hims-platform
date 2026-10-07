import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, TARIFF_LOOKUP_ROLES, TARIFF_MANAGE_ROLES } from '@/lib/role-policy'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/tariff', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/tariff')>('@/lib/queries/tariff')
  return {
    ...actual,
    listServices: vi.fn(), createService: vi.fn(), updateService: vi.fn(), getService: vi.fn(),
    listRoomCategories: vi.fn(), createRoomCategory: vi.fn(), updateRoomCategory: vi.fn(), setRoomCategory: vi.fn(),
  }
})
vi.mock('@/lib/queries/departments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/departments')>('@/lib/queries/departments')
  return { ...actual, getDepartmentById: vi.fn() }
})

import {
  listServices, createService, updateService, getService,
  listRoomCategories, createRoomCategory, updateRoomCategory, setRoomCategory,
} from '@/lib/queries/tariff'
import { getDepartmentById } from '@/lib/queries/departments'
import { logAudit } from '@/lib/audit'
import { GET as listRoute, POST as postService } from '@/app/api/tariff/services/route'
import { PATCH as patchService } from '@/app/api/tariff/services/[id]/route'
import { GET as listCats, POST as postCat } from '@/app/api/tariff/room-categories/route'
import { PATCH as patchCat } from '@/app/api/tariff/room-categories/[id]/route'
import { PUT as putRoomCat } from '@/app/api/tariff/rooms/[id]/category/route'

const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const service = {
  id: 7, code: 'CONS-GEN', name: 'General consultation', departmentId: 3, departmentCode: 'GEN', departmentName: 'General Medicine',
  category: 'consultation', hsnSac: '999312', gstRateBp: 0, isActive: true, createdAt: new Date(), updatedAt: new Date(),
}
const validService = { code: 'cons-gen', name: 'General consultation', departmentId: 3, category: 'consultation', hsnSac: '999312', gstRateBp: 0 }
const cat = { id: 4, code: 'ICU', name: 'ICU', isActive: true, createdAt: new Date() }
const uniqueErr = (constraint: string) => Object.assign(new Error('dup'), { cause: { code: '23505', constraint } })

beforeEach(() => {
  sessionRole = 'admin'
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('GET /api/tariff/services', () => {
  it('GET services admits crc and frontdesk but hides inactive for them', async () => {
    vi.mocked(listServices).mockResolvedValue([service] as never)
    for (const role of ['crc', 'frontdesk'] as const) {
      sessionRole = role
      const res = await listRoute(req('GET', '/api/tariff/services?q=cons&includeInactive=1'))
      expect(res.status).toBe(200)
      expect(vi.mocked(listServices).mock.lastCall?.[0]).toMatchObject({ q: 'cons', includeInactive: false })
    }
    for (const role of TARIFF_MANAGE_ROLES) {
      sessionRole = role
      await listRoute(req('GET', '/api/tariff/services?includeInactive=1&departmentId=3&category=consultation'))
      expect(vi.mocked(listServices).mock.lastCall?.[0]).toMatchObject({ includeInactive: true, departmentId: 3, category: 'consultation' })
    }
  })

  it.each([['hex', '0x10'], ['exponent', '1e3'], ['zero', '0'], ['beyond int4', '2147483648'], ['fraction', '1.5'], ['blank', '']])(
    'GET services rejects a %s departmentId with a fixed 400', async (_l, v) => {
      const res = await listRoute(req('GET', `/api/tariff/services?departmentId=${v}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid service search' })
      expect(listServices).not.toHaveBeenCalled()
    })

  it('GET services accepts a plain departmentId', async () => {
    vi.mocked(listServices).mockResolvedValue([])
    expect((await listRoute(req('GET', '/api/tariff/services?departmentId=2147483647'))).status).toBe(200)
    expect(vi.mocked(listServices).mock.lastCall?.[0]).toMatchObject({ departmentId: 2147483647 })
  })

  it('returns exactly the listed service fields', async () => {
    vi.mocked(listServices).mockResolvedValue([service] as never)
    const res = await listRoute(req('GET', '/api/tariff/services'))
    expect(await res.json()).toEqual({
      services: [{ id: 7, code: 'CONS-GEN', name: 'General consultation', departmentId: 3, departmentName: 'General Medicine', category: 'consultation', hsnSac: '999312', gstRateBp: 0, isActive: true }],
    })
  })

  it('GET services 403s pi, pharmacy, labs', async () => {
    for (const role of ALL_ROLES.filter((r) => !TARIFF_LOOKUP_ROLES.includes(r))) {
      sessionRole = role
      const res = await listRoute(req('GET', '/api/tariff/services'))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(listServices).not.toHaveBeenCalled()
  })

  it('400s a bad query without echoing it', async () => {
    const res = await listRoute(req('GET', '/api/tariff/services?departmentId=abc<x>'))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('abc')
    expect(listServices).not.toHaveBeenCalled()
  })
})

describe('POST /api/tariff/services', () => {
  it('POST services 403s crc and frontdesk before parsing', async () => {
    for (const role of ALL_ROLES.filter((r) => !TARIFF_MANAGE_ROLES.includes(r))) {
      sessionRole = role
      const res = await postService(req('POST', '/api/tariff/services', '{not json'))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(getDepartmentById).not.toHaveBeenCalled()
    expect(createService).not.toHaveBeenCalled()
  })

  it('creates with the upper-cased code and passes the audit into the write', async () => {
    vi.mocked(getDepartmentById).mockResolvedValue({ id: 3 } as never)
    vi.mocked(createService).mockResolvedValue(service as never)
    sessionRole = 'billing'
    const res = await postService(req('POST', '/api/tariff/services', validService))
    expect(res.status).toBe(201)
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CONS-GEN' }),
      { session: expect.objectContaining({ role: 'billing' }), action: 'tariff: created service CONS-GEN' },
    )
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('POST services maps service_catalog_code_unique to 409', async () => {
    vi.mocked(getDepartmentById).mockResolvedValue({ id: 3 } as never)
    vi.mocked(createService).mockRejectedValue(uniqueErr('service_catalog_code_unique'))
    const res = await postService(req('POST', '/api/tariff/services', validService))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Service code already exists' })
  })

  it('POST services 400s an unknown departmentId', async () => {
    vi.mocked(getDepartmentById).mockResolvedValue(null)
    const res = await postService(req('POST', '/api/tariff/services', { ...validService, departmentId: 999 }))
    expect(res.status).toBe(400)
    expect(createService).not.toHaveBeenCalled()
  })

  it('rejects unknown keys, a float GST rate and a SAC on goods with fixed messages', async () => {
    const extra = await postService(req('POST', '/api/tariff/services', { ...validService, evil: '<script>' }))
    expect(extra.status).toBe(400)
    expect(JSON.stringify(await extra.json())).not.toContain('evil')
    expect((await postService(req('POST', '/api/tariff/services', { ...validService, gstRateBp: 1800.5 }))).status).toBe(400)
    const goods = await postService(req('POST', '/api/tariff/services', { ...validService, category: 'pharmacy' }))
    expect(goods.status).toBe(400)
    expect(await goods.json()).toEqual({ error: 'Goods (pharmacy, consumable) need an HSN code, not a SAC' })
    expect(createService).not.toHaveBeenCalled()
  })

  it('500s generically and logs only pg code/constraint', async () => {
    vi.mocked(getDepartmentById).mockResolvedValue({ id: 3 } as never)
    vi.mocked(createService).mockRejectedValue(Object.assign(new Error('secret detail'), { cause: { code: '22001' } }))
    const res = await postService(req('POST', '/api/tariff/services', validService))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret detail')
  })
})

describe('PATCH /api/tariff/services/[id]', () => {
  it('PATCH services refuses a code change', async () => {
    const res = await patchService(req('PATCH', '/api/tariff/services/7', { code: 'NEW' }), ctx('7'))
    expect(res.status).toBe(400)
    expect(updateService).not.toHaveBeenCalled()
  })

  it('PATCH services with isActive:false audits a deactivation', async () => {
    vi.mocked(getService).mockResolvedValue(service as never)
    vi.mocked(updateService).mockResolvedValue({ ...service, isActive: false } as never)
    const res = await patchService(req('PATCH', '/api/tariff/services/7', { isActive: false }), ctx('7'))
    expect(res.status).toBe(200)
    expect(updateService).toHaveBeenCalledWith(7, { isActive: false }, { session: expect.anything(), action: 'tariff: deactivated service CONS-GEN' })
  })

  it('audits a plain update', async () => {
    vi.mocked(getService).mockResolvedValue(service as never)
    vi.mocked(updateService).mockResolvedValue(service as never)
    await patchService(req('PATCH', '/api/tariff/services/7', { name: 'GP consult' }), ctx('7'))
    expect(updateService).toHaveBeenCalledWith(7, { name: 'GP consult' }, { session: expect.anything(), action: 'tariff: updated service CONS-GEN' })
  })

  it('400s a non-integer id, 404s an unknown one, 400s an unknown department', async () => {
    expect((await patchService(req('PATCH', '/api/tariff/services/x', { name: 'A' }), ctx('7.5'))).status).toBe(400)
    vi.mocked(getService).mockResolvedValue(null)
    expect((await patchService(req('PATCH', '/api/tariff/services/9', { name: 'A' }), ctx('9'))).status).toBe(404)
    vi.mocked(getService).mockResolvedValue(service as never)
    vi.mocked(getDepartmentById).mockResolvedValue(null)
    expect((await patchService(req('PATCH', '/api/tariff/services/7', { departmentId: 99 }), ctx('7'))).status).toBe(400)
    expect(updateService).not.toHaveBeenCalled()
  })

  it('checks HSN/SAC against the stored category when only one of them changes', async () => {
    vi.mocked(getService).mockResolvedValue(service as never)
    const res = await patchService(req('PATCH', '/api/tariff/services/7', { category: 'pharmacy' }), ctx('7'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Goods (pharmacy, consumable) need an HSN code, not a SAC' })
    expect(updateService).not.toHaveBeenCalled()
  })

  it('403s a denied role before parsing', async () => {
    sessionRole = 'crc'
    const res = await patchService(req('PATCH', '/api/tariff/services/7', '{not json'), ctx('7'))
    expect(res.status).toBe(403)
    expect(getService).not.toHaveBeenCalled()
  })
})

describe('/api/tariff/room-categories', () => {
  it('GET admits lookup roles; includeInactive only for managers', async () => {
    vi.mocked(listRoomCategories).mockResolvedValue([cat] as never)
    sessionRole = 'frontdesk'
    const res = await listCats(req('GET', '/api/tariff/room-categories?includeInactive=1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ roomCategories: [expect.objectContaining({ code: 'ICU' })] })
    expect(listRoomCategories).toHaveBeenLastCalledWith(false)
    sessionRole = 'billing'
    await listCats(req('GET', '/api/tariff/room-categories?includeInactive=1'))
    expect(listRoomCategories).toHaveBeenLastCalledWith(true)
    sessionRole = 'labs'
    expect((await listCats(req('GET', '/api/tariff/room-categories'))).status).toBe(403)
  })

  it('POST creates and audits inside the write; 409 on room_categories_code_unique', async () => {
    vi.mocked(createRoomCategory).mockResolvedValue(cat as never)
    const ok = await postCat(req('POST', '/api/tariff/room-categories', { code: 'icu', name: 'ICU' }))
    expect(ok.status).toBe(201)
    expect(createRoomCategory).toHaveBeenCalledWith({ code: 'ICU', name: 'ICU' }, { session: expect.anything(), action: 'tariff: created room category ICU' })
    vi.mocked(createRoomCategory).mockRejectedValue(uniqueErr('room_categories_code_unique'))
    const dup = await postCat(req('POST', '/api/tariff/room-categories', { code: 'ICU', name: 'ICU' }))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'Room category code already exists' })
  })

  it('POST 403s frontdesk before parsing', async () => {
    sessionRole = 'frontdesk'
    expect((await postCat(req('POST', '/api/tariff/room-categories', '{not json'))).status).toBe(403)
  })

  it('PATCH updates, audits and 404s an unknown id', async () => {
    vi.mocked(updateRoomCategory).mockResolvedValue({ ...cat, isActive: false } as never)
    const res = await patchCat(req('PATCH', '/api/tariff/room-categories/4', { isActive: false }), ctx('4'))
    expect(res.status).toBe(200)
    expect(updateRoomCategory).toHaveBeenCalledWith(4, { isActive: false }, { session: expect.anything(), action: 'tariff: deactivated room category #4' })
    vi.mocked(updateRoomCategory).mockResolvedValue(null)
    expect((await patchCat(req('PATCH', '/api/tariff/room-categories/5', { name: 'X' }), ctx('5'))).status).toBe(404)
    expect((await patchCat(req('PATCH', '/api/tariff/room-categories/5', {}), ctx('5'))).status).toBe(400)
  })
})

describe('PUT /api/tariff/rooms/[id]/category', () => {
  it('PUT rooms/[id]/category accepts null to clear', async () => {
    vi.mocked(setRoomCategory).mockResolvedValue(true)
    const res = await putRoomCat(req('PUT', '/api/tariff/rooms/12/category', { roomCategoryId: null }), ctx('12'))
    expect(res.status).toBe(200)
    expect(setRoomCategory).toHaveBeenCalledWith(12, null, { session: expect.anything(), action: 'tariff: set room category for room #12' })
    expect(listRoomCategories).not.toHaveBeenCalled()
  })

  it('assigns an active category, 400s an unknown one, 404s an unknown room', async () => {
    vi.mocked(listRoomCategories).mockResolvedValue([cat] as never)
    vi.mocked(setRoomCategory).mockResolvedValue(true)
    expect((await putRoomCat(req('PUT', '/api/tariff/rooms/12/category', { roomCategoryId: 4 }), ctx('12'))).status).toBe(200)
    expect(listRoomCategories).toHaveBeenCalledWith(false)
    expect((await putRoomCat(req('PUT', '/api/tariff/rooms/12/category', { roomCategoryId: 99 }), ctx('12'))).status).toBe(400)
    vi.mocked(setRoomCategory).mockResolvedValue(false)
    expect((await putRoomCat(req('PUT', '/api/tariff/rooms/13/category', { roomCategoryId: 4 }), ctx('13'))).status).toBe(404)
  })

  it('400s a missing body field and 403s crc before parsing', async () => {
    expect((await putRoomCat(req('PUT', '/api/tariff/rooms/12/category', {}), ctx('12'))).status).toBe(400)
    sessionRole = 'crc'
    expect((await putRoomCat(req('PUT', '/api/tariff/rooms/12/category', '{not json'), ctx('12'))).status).toBe(403)
    expect(setRoomCategory).not.toHaveBeenCalled()
  })
})
