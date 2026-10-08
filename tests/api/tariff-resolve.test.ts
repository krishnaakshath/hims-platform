import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'

let sessionRole: Role | null = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    requireSession: vi.fn(async () =>
      sessionRole === null ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) : { role: sessionRole, name: 'Probe', userId: null }),
  }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/tariff', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/tariff')>('@/lib/queries/tariff')
  return { ...actual, loadPricingContext: vi.fn(), getServiceByCode: vi.fn() }
})

import { loadPricingContext, getServiceByCode } from '@/lib/queries/tariff'
import { logAudit } from '@/lib/audit'
import { GET as resolveTariff } from '@/app/api/tariff/resolve/route'

const get = (qs: string) => new NextRequest(`http://localhost/api/tariff/resolve${qs}`)

const service = { id: 7, code: 'CONS-GEN', name: 'General consultation', departmentId: 3, isActive: true, hsnSac: '999312', gstRateBp: 0 }
const rate = (over: Record<string, unknown> = {}) => ({
  id: 11, serviceId: 7, scope: 'base', departmentId: null, payerId: null, roomCategoryCode: null, ward: null,
  amountPaise: 50_000, validFrom: '2026-10-07', validTo: null, deactivated: false, ...over,
})

beforeEach(() => {
  sessionRole = 'frontdesk'
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(loadPricingContext).mockResolvedValue({ service, rates: [rate()] } as never)
})
afterEach(() => { vi.useRealTimers() })

describe('GET /api/tariff/resolve', () => {
  it('frontdesk can look up a price; pi, pharmacy, labs cannot', async () => {
    for (const role of TARIFF_LOOKUP_ROLES) {
      sessionRole = role
      const res = await resolveTariff(get('?serviceId=7&onDate=2026-10-07'))
      expect(res.status, role).toBe(200)
    }
    const denied = ALL_ROLES.filter((r) => !TARIFF_LOOKUP_ROLES.includes(r))
    expect(denied).toEqual(expect.arrayContaining(['pi', 'pharmacy', 'labs', 'coder', 'collector']))
    vi.mocked(loadPricingContext).mockClear()
    for (const role of denied) {
      sessionRole = role
      // Even an invalid query must be denied before it is parsed.
      const res = await resolveTariff(get('?patientId=RD-1'))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(loadPricingContext).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    sessionRole = null
    const res = await resolveTariff(get('?serviceId=7'))
    expect(res.status).toBe(401)
    expect(loadPricingContext).not.toHaveBeenCalled()
  })

  it('rejects an unknown query parameter such as patientId', async () => {
    const res = await resolveTariff(get('?serviceId=7&patientId=RD-1234'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid price lookup' })
    expect(loadPricingContext).not.toHaveBeenCalled()
  })

  it.each([
    ['no service', ''],
    ['both serviceId and serviceCode', '?serviceId=7&serviceCode=CONS-GEN'],
    ['zero id', '?serviceId=0'],
    ['negative id', '?serviceId=-3'],
    ['fractional id', '?serviceId=1.5'],
    ['exponent id', '?serviceId=1e3'],
    ['hex id', '?serviceId=0x10'],
    ['id beyond int4', '?serviceId=99999999999'],
    ['payerId beyond int4', '?serviceId=7&payerId=2147483648'],
    ['blank departmentId', '?serviceId=7&departmentId='],
    ['a repeated parameter', '?serviceId=7&serviceId=8'],
    ['malformed date', '?serviceId=7&onDate=07-10-2026'],
    ['impossible date', '?serviceId=7&onDate=2026-02-30'],
  ])('rejects %s with a fixed 400', async (_label, qs) => {
    const res = await resolveTariff(get(qs))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid price lookup' })
    expect(loadPricingContext).not.toHaveBeenCalled()
  })

  it('defaults onDate to today in Asia/Kolkata', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T19:00:00Z')) // already 7 Oct in IST
    const res = await resolveTariff(get('?serviceId=7'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.amountPaise).toBe(50_000)
    expect(loadPricingContext).toHaveBeenCalledWith(7)
  })

  it('a rate starting tomorrow (IST) does not price today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T18:00:00Z')) // 23:30 on 6 Oct in IST
    const res = await resolveTariff(get('?serviceId=7'))
    expect(await res.json()).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('resolves by serviceCode and returns the formatted INR amount', async () => {
    vi.mocked(getServiceByCode).mockResolvedValue({ ...service, departmentCode: 'GEN', departmentName: 'General Medicine' } as never)
    const res = await resolveTariff(get('?serviceCode=CONS-GEN&onDate=2026-10-07'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(getServiceByCode).toHaveBeenCalledWith('CONS-GEN')
    expect(loadPricingContext).toHaveBeenCalledWith(7)
    expect(body).toEqual({
      ok: true, serviceId: 7, serviceCode: 'CONS-GEN', serviceName: 'General consultation', amountPaise: 50_000,
      currency: 'INR', gstRateBp: 0, hsnSac: '999312', rateId: 11, scope: 'base',
      matched: { roomCategory: false, ward: false }, formatted: '₹500.00',
    })
  })

  it('upper-cases a serviceCode before the lookup', async () => {
    vi.mocked(getServiceByCode).mockResolvedValue(null)
    await resolveTariff(get('?serviceCode=cons-gen'))
    expect(getServiceByCode).toHaveBeenCalledWith('CONS-GEN')
  })

  it('an unknown serviceCode is 200 service_not_found', async () => {
    vi.mocked(getServiceByCode).mockResolvedValue(null)
    const res = await resolveTariff(get('?serviceCode=NOPE&onDate=2026-10-07'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'service_not_found' })
    expect(loadPricingContext).not.toHaveBeenCalled()
  })

  it('returns ok:false no_rate with 200', async () => {
    vi.mocked(loadPricingContext).mockResolvedValue({ service, rates: [] } as never)
    const res = await resolveTariff(get('?serviceId=7&onDate=2026-10-07'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('passes payer, department, room category and ward to the resolver', async () => {
    vi.mocked(loadPricingContext).mockResolvedValue({
      service,
      rates: [rate(), rate({ id: 12, scope: 'payer', payerId: 5, amountPaise: 42_000 }), rate({ id: 13, roomCategoryCode: 'ICU', ward: 'icu ward', amountPaise: 90_000 })],
    } as never)
    const payer = await (await resolveTariff(get('?serviceId=7&payerId=5&onDate=2026-10-07'))).json()
    expect(payer).toMatchObject({ ok: true, rateId: 12, scope: 'payer', formatted: '₹420.00' })
    const room = await (await resolveTariff(get('?serviceId=7&roomCategory=icu&ward=%20ICU%20%20Ward&onDate=2026-10-07'))).json()
    expect(room).toMatchObject({ ok: true, rateId: 13, matched: { roomCategory: true, ward: true } })
  })

  it('writes no audit entry', async () => {
    await resolveTariff(get('?serviceId=7&onDate=2026-10-07'))
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('a DB failure is a generic 500', async () => {
    vi.mocked(loadPricingContext).mockRejectedValue(Object.assign(new Error('boom select secret'), { code: '57P01' }))
    const res = await resolveTariff(get('?serviceId=7&onDate=2026-10-07'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not look up the price' })
  })
})
