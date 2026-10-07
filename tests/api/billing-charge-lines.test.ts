import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let role = 'crc'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: 7 })),
}))
vi.mock('@/lib/queries/charge-capture', () => ({
  previewChargeLine: vi.fn(),
  captureChargeLine: vi.fn(),
  voidChargeLine: vi.fn(),
}))

import { POST as capture } from '@/app/api/billing/charge-lines/route'
import { POST as preview } from '@/app/api/billing/charge-lines/preview/route'
import { POST as voidLine } from '@/app/api/billing/charge-lines/[id]/void/route'
import { captureChargeLine, previewChargeLine, voidChargeLine } from '@/lib/queries/charge-capture'

const send = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const VALID = { context: { encounterId: 5 }, serviceId: 3, quantity: 1, serviceDate: '2099-06-01', billTo: 'patient' }
const VIOLATION = { code: 'duplicate_charge', severity: 'block', message: 'This service is already charged for this visit on this date', field: 'serviceId', overridable: true }

beforeEach(() => {
  role = 'crc'
  vi.mocked(captureChargeLine).mockReset().mockResolvedValue({ ok: true, line: { id: 9 } as never, violations: [] })
  vi.mocked(previewChargeLine).mockReset()
  vi.mocked(voidChargeLine).mockReset().mockResolvedValue({ ok: true })
})

describe('charge-line routes', () => {
  it.each(['frontdesk', 'pi', 'pharmacy', 'labs'])('%s is 403 before the body is read', async (r) => {
    role = r
    for (const res of [
      await capture(send('/api/billing/charge-lines', '{not json')),
      await preview(send('/api/billing/charge-lines/preview', '{not json')),
      await voidLine(send('/api/billing/charge-lines/1/void', '{not json'), ctx('1')),
    ]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(captureChargeLine).not.toHaveBeenCalled()
    expect(previewChargeLine).not.toHaveBeenCalled()
    expect(voidChargeLine).not.toHaveBeenCalled()
  })

  it('a capture is a 201 with the line and violations', async () => {
    const res = await capture(send('/api/billing/charge-lines', VALID))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ line: { id: 9 }, violations: [] })
    expect(captureChargeLine).toHaveBeenCalledWith(VALID, expect.objectContaining({ role: 'crc' }))
  })

  it('a blocked capture is a 422 with the typed violations', async () => {
    vi.mocked(captureChargeLine).mockResolvedValue({ ok: false, error: 'blocked', violations: [VIOLATION as never] })
    const res = await capture(send('/api/billing/charge-lines', VALID))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'This charge breaks billing rules', violations: [VIOLATION] })
  })

  it('a crc manual price is a 403 with the exact message', async () => {
    vi.mocked(captureChargeLine).mockResolvedValue({ ok: false, error: 'price_override_forbidden' })
    const res = await capture(send('/api/billing/charge-lines', { ...VALID, manualUnitPricePaise: 100, priceOverrideReason: 'Agreed rate' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only billing or admin staff can override a price' })
  })

  it.each([
    ['context_not_found', 404, 'Visit or admission not found'],
    ['context_cancelled', 409, 'This visit was cancelled; charges cannot be added'],
    ['no_payer', 400, 'This patient has no primary payer on file'],
  ] as const)('%s maps to %i', async (error, status, message) => {
    vi.mocked(captureChargeLine).mockResolvedValue({ ok: false, error })
    const res = await capture(send('/api/billing/charge-lines', VALID))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
    vi.mocked(previewChargeLine).mockResolvedValue({ ok: false, error })
    const pre = await preview(send('/api/billing/charge-lines/preview', VALID))
    expect(pre.status).toBe(status)
  })

  it('preview returns 200 with unresolved blocks instead of 422', async () => {
    const p = { price: { ok: false, reason: 'no_rate' }, unitPricePaise: null, priceSource: null, taxablePaise: null, estimatedTax: null, violations: [VIOLATION], unresolved: ['duplicate_charge'] }
    vi.mocked(previewChargeLine).mockResolvedValue({ ok: true, preview: p as never })
    const res = await preview(send('/api/billing/charge-lines/preview', VALID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ preview: p })
  })

  it('an invalid body is a 400 with the authored or generic message; bad JSON is 400', async () => {
    const r1 = await capture(send('/api/billing/charge-lines', { ...VALID, manualUnitPricePaise: 100 }))
    expect(r1.status).toBe(400)
    expect(await r1.json()).toEqual({ error: 'Give a reason for the manual price (at least 5 characters)' })
    const r2 = await capture(send('/api/billing/charge-lines', { ...VALID, quantity: 0 }))
    expect(await r2.json()).toEqual({ error: 'Invalid charge' })
    const r3 = await capture(send('/api/billing/charge-lines', '{not json'))
    expect(r3.status).toBe(400)
    expect(await r3.json()).toEqual({ error: 'Invalid JSON' })
    expect(captureChargeLine).not.toHaveBeenCalled()
  })

  it('a 40P01 thrown by the query is a 409 with the retry message', async () => {
    vi.mocked(captureChargeLine).mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }))
    const res = await capture(send('/api/billing/charge-lines', VALID))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Another change was being saved at the same time; please try again' })
    vi.mocked(voidChargeLine).mockRejectedValue(Object.assign(new Error('x'), { code: '40001' }))
    expect((await voidLine(send('/api/billing/charge-lines/1/void', { reason: 'Wrong visit' }), ctx('1'))).status).toBe(409)
  })

  it('an unknown performing doctor (FK violation) is a 400, not a 500', async () => {
    vi.mocked(captureChargeLine).mockRejectedValue(Object.assign(new Error('fk'), { code: '23503', constraint: 'charge_lines_performing_provider_id_providers_id_fk' }))
    const res = await capture(send('/api/billing/charge-lines', { ...VALID, performingProviderId: 999 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Performing doctor not found' })
  })

  it('void: 200, 400 bad id, 404, 409', async () => {
    const ok = await voidLine(send('/api/billing/charge-lines/4/void', { reason: 'Wrong visit' }), ctx('4'))
    expect(ok.status).toBe(200)
    expect(voidChargeLine).toHaveBeenCalledWith(4, 'Wrong visit', expect.objectContaining({ role: 'crc' }))
    expect((await voidLine(send('/api/billing/charge-lines/x/void', { reason: 'Wrong visit' }), ctx('x'))).status).toBe(400)
    expect((await voidLine(send('/api/billing/charge-lines/4/void', { reason: 'no' }), ctx('4'))).status).toBe(400)
    vi.mocked(voidChargeLine).mockResolvedValue({ ok: false, error: 'not_found' })
    const nf = await voidLine(send('/api/billing/charge-lines/4/void', { reason: 'Wrong visit' }), ctx('4'))
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'Charge line not found' })
    vi.mocked(voidChargeLine).mockResolvedValue({ ok: false, error: 'not_voidable' })
    const nv = await voidLine(send('/api/billing/charge-lines/4/void', { reason: 'Wrong visit' }), ctx('4'))
    expect(nv.status).toBe(409)
    expect(await nv.json()).toEqual({ error: 'Only a charge that is not yet invoiced can be voided' })
  })
})
