import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { planRevision } from '@/lib/tariff/versions'

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
    createRate: vi.fn(), reviseRate: vi.fn(), endRate: vi.fn(), deactivateRate: vi.fn(), getRate: vi.fn(), getService: vi.fn(),
    listRatesForService: vi.fn(), listRoomCategories: vi.fn(), replacePackageItems: vi.fn(),
  }
})
vi.mock('@/lib/queries/departments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/departments')>('@/lib/queries/departments')
  return { ...actual, getDepartmentById: vi.fn() }
})
vi.mock('@/lib/queries/payers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/payers')>('@/lib/queries/payers')
  return { ...actual, getPayerById: vi.fn() }
})

import {
  createRate, reviseRate, endRate, deactivateRate, getRate, getService, listRatesForService, listRoomCategories,
  replacePackageItems, TariffOverlapError,
} from '@/lib/queries/tariff'
import { getDepartmentById } from '@/lib/queries/departments'
import { getPayerById } from '@/lib/queries/payers'
import { logAudit } from '@/lib/audit'
import { POST } from '@/app/api/tariff/rates/route'
import { PATCH as patchRate } from '@/app/api/tariff/rates/[id]/route'
import { POST as revise } from '@/app/api/tariff/rates/[id]/revise/route'
import { REVISION_ERRORS } from '@/lib/tariff/route-responses'
import { PUT as putItems } from '@/app/api/tariff/packages/[id]/items/route'

const req = (body: unknown, method = 'POST', path = '/api/tariff/rates') =>
  new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const svc = (over: Record<string, unknown> = {}) => ({
  id: 7, code: 'CONS-GEN', name: 'General consultation', departmentId: 3, departmentCode: 'GEN', departmentName: 'Gen',
  category: 'consultation', hsnSac: '999312', gstRateBp: 0, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...over,
})
const rate = (over: Record<string, unknown> = {}) => ({
  id: 5, serviceId: 7, scope: 'base', departmentId: null, payerId: null, roomCategoryId: null, ward: null, amountPaise: 50000,
  currency: 'INR', validFrom: '2026-01-01', validTo: null, deactivatedAt: null, createdByName: 'x', createdAt: new Date(),
  payerName: null, departmentName: null, roomCategoryCode: null, ...over,
})
const validRate = (over: Record<string, unknown> = {}) => ({ serviceId: 7, scope: 'base', amountPaise: 50000, validFrom: '2026-04-01', ...over })
const OVERLAP = { error: 'This rate overlaps an existing rate for the same service, scope and room/ward' }

beforeEach(() => {
  sessionRole = 'admin'
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(getService).mockResolvedValue(svc() as never)
  vi.mocked(listRatesForService).mockResolvedValue([])
})

describe('POST /api/tariff/rates', () => {
  it('POST rates 403s crc and frontdesk before parsing', async () => {
    for (const role of ALL_ROLES.filter((r) => !TARIFF_MANAGE_ROLES.includes(r))) {
      sessionRole = role
      const res = await POST(req('{not json'))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(getService).not.toHaveBeenCalled()
    expect(createRate).not.toHaveBeenCalled()
  })

  it('creates with the session name and the audit passed into the write', async () => {
    vi.mocked(createRate).mockResolvedValue(rate() as never)
    sessionRole = 'billing'
    const res = await POST(req(validRate()))
    expect(res.status).toBe(201)
    expect(createRate).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 7, amountPaise: 50000 }), 'Probe',
      { session: expect.objectContaining({ role: 'billing' }), action: 'tariff: added base rate for CONS-GEN' },
    )
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('POST rates maps TariffOverlapError to 409', async () => {
    vi.mocked(createRate).mockRejectedValue(new TariffOverlapError(3))
    const res = await POST(req(validRate()))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(OVERLAP)
  })

  it('maps tariff_rates_no_overlap exclusion to 409', async () => {
    vi.mocked(createRate).mockRejectedValue({ message: 'Failed query', cause: { code: '23P01', constraint: 'tariff_rates_no_overlap' } })
    const res = await POST(req(validRate()))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(OVERLAP)
  })

  it('400s an unknown service, department, payer or room category', async () => {
    vi.mocked(getService).mockResolvedValueOnce(null)
    expect(await (await POST(req(validRate()))).json()).toEqual({ error: 'Unknown service' })
    vi.mocked(getDepartmentById).mockResolvedValue(null)
    expect(await (await POST(req(validRate({ scope: 'department', departmentId: 9 })))).json()).toEqual({ error: 'Unknown department' })
    vi.mocked(getPayerById).mockResolvedValue(null)
    expect(await (await POST(req(validRate({ scope: 'payer', payerId: 9 })))).json()).toEqual({ error: 'Unknown payer' })
    vi.mocked(listRoomCategories).mockResolvedValue([{ id: 1, code: 'ICU' }] as never)
    const res = await POST(req(validRate({ roomCategoryId: 9 })))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Unknown room category' })
    expect(createRate).not.toHaveBeenCalled()
  })

  it('rejects non-integer paise, the wrong scope keys and unknown keys without echoing input', async () => {
    expect((await POST(req(validRate({ amountPaise: 500.5 })))).status).toBe(400)
    const scope = await POST(req(validRate({ departmentId: 3 })))
    expect(scope.status).toBe(400)
    expect(await scope.json()).toEqual({ error: 'Scope "base" has the wrong department/payer keys' })
    const extra = await POST(req(validRate({ patientId: 'RD-1234' })))
    expect(extra.status).toBe(400)
    expect(JSON.stringify(await extra.json())).not.toContain('patientId')
    expect(createRate).not.toHaveBeenCalled()
  })

  it('caps amounts at ₹1 crore (int4 column): 1_000_000_000 ok, one paisa more is a fixed 400', async () => {
    vi.mocked(createRate).mockResolvedValue(rate({ amountPaise: 1_000_000_000 }) as never)
    expect((await POST(req(validRate({ amountPaise: 1_000_000_000 })))).status).toBe(201)
    for (const amountPaise of [1_000_000_001, 2_147_483_648, 10_000_000_000]) {
      vi.mocked(createRate).mockClear()
      const res = await POST(req(validRate({ amountPaise })))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Amount cannot exceed ₹1,00,00,000' })
      expect(createRate).not.toHaveBeenCalled()
    }
  })

  it('500s generically, logging only the pg code and constraint', async () => {
    vi.mocked(createRate).mockRejectedValue(Object.assign(new Error('secret detail'), { cause: { code: '08006' } }))
    const res = await POST(req(validRate()))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret detail')
  })
})

describe('POST /api/tariff/rates/[id]/revise', () => {
  it('revise returns 400 with the planRevision message for a back-dated revision', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(reviseRate).mockRejectedValue(new Error('New rate must start after the current rate starts'))
    const res = await revise(req({ amountPaise: 1, effectiveFrom: '2020-01-01' }), ctx('5'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'New rate must start after the current rate starts' })
  })

  it('REVISION_ERRORS covers every message planRevision can produce', () => {
    const current = { id: 5, serviceId: 7, scope: 'base' as const, departmentId: null, payerId: null, roomCategoryId: null, ward: null, validFrom: '2026-01-01', validTo: '2026-06-30', amountPaise: 100, deactivated: false }
    const messages = [
      planRevision({ ...current, deactivated: true }, { amountPaise: 1, effectiveFrom: '2026-02-01' }),
      planRevision(current, { amountPaise: 1, effectiveFrom: '2026-01-01' }),
      planRevision(current, { amountPaise: 1, effectiveFrom: '2026-07-01' }),
      planRevision(current, { amountPaise: 100, effectiveFrom: '2026-02-01' }),
    ].map((p) => (p.ok ? null : p.error))
    expect(new Set(messages)).toEqual(new Set(REVISION_ERRORS))
  })

  it('does not echo an unexpected error message', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(reviseRate).mockRejectedValue(new Error('relation "x" secret'))
    const res = await revise(req({ amountPaise: 1, effectiveFrom: '2026-05-01' }), ctx('5'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })

  it('maps an overlap (app or DB) to 409', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(reviseRate).mockRejectedValueOnce(new TariffOverlapError(null))
    expect((await revise(req({ amountPaise: 1, effectiveFrom: '2026-05-01' }), ctx('5'))).status).toBe(409)
    vi.mocked(reviseRate).mockRejectedValueOnce({ cause: { code: '23P01', constraint: 'tariff_rates_no_overlap' } })
    expect(await (await revise(req({ amountPaise: 1, effectiveFrom: '2026-05-01' }), ctx('5'))).json()).toEqual(OVERLAP)
  })

  it('caps the revised amount at ₹1 crore with a fixed 400', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(reviseRate).mockResolvedValue({ closed: rate({ validTo: '2026-04-30' }), created: rate({ id: 6, amountPaise: 1_000_000_000 }) } as never)
    expect((await revise(req({ amountPaise: 1_000_000_000, effectiveFrom: '2026-05-01' }), ctx('5'))).status).toBe(200)
    vi.mocked(reviseRate).mockClear()
    const res = await revise(req({ amountPaise: 1_000_000_001, effectiveFrom: '2026-05-01' }), ctx('5'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Amount cannot exceed ₹1,00,00,000' })
    expect(reviseRate).not.toHaveBeenCalled()
  })

  it('returns closed and created and audits inside the write', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(reviseRate).mockResolvedValue({ closed: rate({ validTo: '2026-04-30' }), created: rate({ id: 6, validFrom: '2026-05-01', amountPaise: 60000 }) } as never)
    const res = await revise(req({ amountPaise: 60000, effectiveFrom: '2026-05-01' }), ctx('5'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.closed.validTo).toBe('2026-04-30')
    expect(body.created.id).toBe(6)
    expect(reviseRate).toHaveBeenCalledWith(5, { amountPaise: 60000, effectiveFrom: '2026-05-01' }, 'Probe',
      { session: expect.anything(), action: 'tariff: revised rate #5 for CONS-GEN from 2026-05-01' })
  })

  it('404s an unknown rate, 400s a bad id, 403s crc before parsing', async () => {
    vi.mocked(getRate).mockResolvedValue(null)
    expect((await revise(req({ amountPaise: 1, effectiveFrom: '2026-05-01' }), ctx('5'))).status).toBe(404)
    expect((await revise(req({ amountPaise: 1, effectiveFrom: '2026-05-01' }), ctx('abc'))).status).toBe(400)
    sessionRole = 'crc'
    expect((await revise(req('{not json'), ctx('5'))).status).toBe(403)
    expect(reviseRate).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/tariff/rates/[id]', () => {
  const patch = (body: unknown, id = '5') => patchRate(req(body, 'PATCH', `/api/tariff/rates/${id}`), ctx(id))

  it('PATCH rates deactivates and audits', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(deactivateRate).mockResolvedValue(rate({ deactivatedAt: new Date() }) as never)
    const res = await patch({ deactivate: true })
    expect(res.status).toBe(200)
    expect(deactivateRate).toHaveBeenCalledWith(5, { session: expect.anything(), action: 'tariff: deactivated rate #5' })
    expect(endRate).not.toHaveBeenCalled()
  })

  it('ends a rate and audits; 400 when validTo is before validFrom', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(endRate).mockResolvedValue(rate({ validTo: '2026-03-31' }) as never)
    expect((await patch({ validTo: '2026-03-31' })).status).toBe(200)
    expect(endRate).toHaveBeenCalledWith(5, '2026-03-31', { session: expect.anything(), action: 'tariff: ended rate #5' })
    const early = await patch({ validTo: '2025-12-31' })
    expect(early.status).toBe(400)
    expect(await early.json()).toEqual({ error: 'Valid-to cannot be before valid-from' })
    expect(endRate).toHaveBeenCalledTimes(1)
  })

  it('409s an end date that would overlap a later version (checked inside endRate, under the service lock)', async () => {
    vi.mocked(getRate).mockResolvedValue(rate({ validTo: '2026-03-31' }) as never)
    vi.mocked(endRate).mockRejectedValue(new TariffOverlapError(9))
    const res = await patch({ validTo: '2026-12-31' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(OVERLAP)
    // The route no longer runs its own unlocked pre-check.
    expect(listRatesForService).not.toHaveBeenCalled()
  })

  it.each([['deadlock', '40P01'], ['serialization failure', '40001']])('maps a %s to a 409 asking to try again', async (_l, code) => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(endRate).mockRejectedValue(Object.assign(new Error('x'), { cause: { code } }))
    const res = await patch({ validTo: '2026-12-31' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Another change was being saved at the same time; please try again' })
    vi.mocked(createRate).mockRejectedValue(Object.assign(new Error('x'), { cause: { code } }))
    expect((await POST(req(validRate()))).status).toBe(409)
  })

  it('maps the DB exclusion on end to 409, refuses a deactivated rate, 404s and 400s', async () => {
    vi.mocked(getRate).mockResolvedValue(rate() as never)
    vi.mocked(endRate).mockRejectedValue({ cause: { code: '23P01', constraint: 'tariff_rates_no_overlap' } })
    expect((await patch({ validTo: '2026-12-31' })).status).toBe(409)
    vi.mocked(getRate).mockResolvedValue(rate({ deactivatedAt: new Date() }) as never)
    expect(await (await patch({ validTo: '2026-12-31' })).json()).toEqual({ error: 'The rate is deactivated' })
    vi.mocked(getRate).mockResolvedValue(null)
    expect((await patch({ deactivate: true })).status).toBe(404)
    expect((await patch({ deactivate: true, validTo: '2026-12-31' })).status).toBe(400)
    expect((await patch({ deactivate: false })).status).toBe(400)
  })
})

describe('PUT /api/tariff/packages/[id]/items', () => {
  const put = (body: unknown, id = '20') => putItems(req(body, 'PUT', `/api/tariff/packages/${id}/items`), ctx(id))
  const pkg = svc({ id: 20, code: 'PKG-CATARACT', category: 'package' })
  const byId = (rows: ReturnType<typeof svc>[]) => vi.mocked(getService).mockImplementation(async (id: number) => (rows.find((r) => r.id === id) ?? null) as never)

  it('PUT package items rejects a nested package', async () => {
    byId([pkg, svc({ id: 21, code: 'PKG-OTHER', category: 'package' })])
    const res = await put({ items: [{ serviceId: 21, quantity: 1 }] })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'PKG-OTHER is a package; packages cannot be nested' })
    expect(replacePackageItems).not.toHaveBeenCalled()
  })

  it('replaces the items and audits inside the write', async () => {
    byId([pkg, svc({ id: 7 }), svc({ id: 8, code: 'LAB-CBC', category: 'investigation_lab' })])
    vi.mocked(replacePackageItems).mockResolvedValue(undefined)
    sessionRole = 'billing'
    const items = [{ serviceId: 7, quantity: 1 }, { serviceId: 8, quantity: 2 }]
    const res = await put({ items })
    expect(res.status).toBe(200)
    expect(replacePackageItems).toHaveBeenCalledWith(20, items, { session: expect.anything(), action: 'tariff: updated package items for PKG-CATARACT' })
  })

  it('400s a non-package, an unknown item and a duplicate; 404s an unknown package; 403s frontdesk first', async () => {
    byId([svc({ id: 7 }), pkg])
    expect(await (await put({ items: [] }, '7')).json()).toEqual({ error: 'CONS-GEN is not a package' })
    expect(await (await put({ items: [{ serviceId: 99, quantity: 1 }] })).json()).toEqual({ error: 'Unknown service #99' })
    expect((await put({ items: [{ serviceId: 7, quantity: 1 }, { serviceId: 7, quantity: 2 }] })).status).toBe(400)
    expect((await put({ items: [{ serviceId: 7, quantity: 1.5 }] })).status).toBe(400)
    expect((await put({ items: [] }, '404')).status).toBe(404)
    sessionRole = 'frontdesk'
    expect((await put('{not json')).status).toBe(403)
    expect(replacePackageItems).not.toHaveBeenCalled()
  })
})
