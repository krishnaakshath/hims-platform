import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Foundations T11: the UPI QR request and confirm routes.
let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: 7 })) }))
vi.mock('@/lib/payments/manual-upi', () => ({ createUpiRequest: vi.fn(), confirmUpiRequest: vi.fn() }))

import { POST as createRoute } from '@/app/api/billing/payments/upi-request/route'
import { POST as confirmRoute } from '@/app/api/billing/payments/upi-request/[id]/confirm/route'
import { confirmUpiRequest, createUpiRequest } from '@/lib/payments/manual-upi'

const req = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const CREATE = { patientId: 'RD-0001', amountPaise: 50000 }
const CREATED = { ok: true, requestId: 9, uri: 'upi://pay?pa=a@ybl&pn=X&am=500.00&cu=INR&tn=n', qrDataUrl: 'data:image/png;base64,AAA', vpa: 'a@ybl', payeeName: 'X', amountPaise: 50000, note: 'n' }

beforeEach(() => {
  role = 'frontdesk'
  vi.mocked(createUpiRequest).mockReset().mockResolvedValue(CREATED as never)
  vi.mocked(confirmUpiRequest).mockReset().mockResolvedValue({ ok: true, receiptNumber: 'RCT/26-27/000001', paymentId: 5 })
})

describe('POST /api/billing/payments/upi-request', () => {
  it('creates a request and returns the QR, the URI, the UPI id and the amount', async () => {
    const res = await createRoute(req('/api/billing/payments/upi-request', CREATE))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ requestId: 9, uri: CREATED.uri, qrDataUrl: CREATED.qrDataUrl, vpa: 'a@ybl', payeeName: 'X', amountPaise: 50000 })
    expect(createUpiRequest).toHaveBeenCalledWith(CREATE, expect.objectContaining({ role: 'frontdesk' }))
  })

  it('without HOSPITAL_UPI_VPA answers a clear 503', async () => {
    vi.mocked(createUpiRequest).mockResolvedValueOnce({ ok: false, error: 'not_configured' })
    const res = await createRoute(req('/api/billing/payments/upi-request', CREATE))
    expect([res.status, await res.json()]).toEqual([503, { error: 'UPI is not set up. Ask your administrator.' }])
  })

  it.each(['pi', 'pharmacy', 'labs', 'rcm'])('%s is 403 before the body is read', async (r) => {
    role = r
    const res = await createRoute(req('/api/billing/payments/upi-request', '{not json'))
    expect([res.status, await res.json()]).toEqual([403, { error: 'Forbidden' }])
    expect(createUpiRequest).not.toHaveBeenCalled()
  })

  it('a strict body: unknown keys, float or non-positive amounts are 400', async () => {
    for (const body of [{ ...CREATE, extra: 1 }, { ...CREATE, amountPaise: 10.5 }, { ...CREATE, amountPaise: 0 }, { patientId: 'RD-1' }]) {
      expect((await createRoute(req('/api/billing/payments/upi-request', body))).status).toBe(400)
    }
    expect(createUpiRequest).not.toHaveBeenCalled()
  })

  it('maps lookup errors', async () => {
    vi.mocked(createUpiRequest).mockResolvedValueOnce({ ok: false, error: 'patient_not_found' })
    expect((await createRoute(req('/api/billing/payments/upi-request', CREATE))).status).toBe(404)
    vi.mocked(createUpiRequest).mockResolvedValueOnce({ ok: false, error: 'invoice_not_payable' })
    expect((await createRoute(req('/api/billing/payments/upi-request', { ...CREATE, kind: 'receipt', invoiceId: 3 }))).status).toBe(409)
  })
})

describe('POST /api/billing/payments/upi-request/[id]/confirm', () => {
  it('confirms with a UTR and returns the receipt', async () => {
    const res = await confirmRoute(req('/x', { utr: '412345678901' }), ctx('9'))
    expect([res.status, await res.json()]).toEqual([201, { receiptNumber: 'RCT/26-27/000001', paymentId: 5 }])
    expect(confirmUpiRequest).toHaveBeenCalledWith({ requestId: 9, utr: '412345678901' }, expect.objectContaining({ role: 'frontdesk' }))
  })

  it('the same UTR again is a 409 with a plain message', async () => {
    vi.mocked(confirmUpiRequest).mockResolvedValueOnce({ ok: false, error: 'duplicate_utr' })
    const dup = await confirmRoute(req('/x', { utr: '412345678901' }), ctx('9'))
    expect([dup.status, await dup.json()]).toEqual([409, { error: 'This UTR has already been recorded' }])
    vi.mocked(confirmUpiRequest).mockResolvedValueOnce({ ok: false, error: 'already_confirmed' })
    const again = await confirmRoute(req('/x', { utr: '412345678901' }), ctx('9'))
    expect([again.status, await again.json()]).toEqual([409, { error: 'This UPI payment has already been recorded' }])
  })

  it('a bad id or a bad UTR is a 400/404 before any write; unknown request is 404', async () => {
    expect((await confirmRoute(req('/x', { utr: '412345678901' }), ctx('abc'))).status).toBe(404)
    expect((await confirmRoute(req('/x', { utr: 'x' }), ctx('9'))).status).toBe(400)
    expect((await confirmRoute(req('/x', { utr: '412345678901', amountPaise: 5 }), ctx('9'))).status).toBe(400)
    expect(confirmUpiRequest).not.toHaveBeenCalled()
    vi.mocked(confirmUpiRequest).mockResolvedValueOnce({ ok: false, error: 'request_not_found' })
    expect((await confirmRoute(req('/x', { utr: '412345678901' }), ctx('9'))).status).toBe(404)
  })

  it('pi is 403 before the body is read', async () => {
    role = 'pi'
    const res = await confirmRoute(req('/x', '{not json'), ctx('9'))
    expect([res.status, await res.json()]).toEqual([403, { error: 'Forbidden' }])
  })
})
