import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: 7 })) }))
vi.mock('@/lib/queries/patient-ledger', () => ({ recordPayment: vi.fn(), issueRefund: vi.fn() }))

import { POST as postPayment } from '@/app/api/billing/payments/route'
import { POST as postRefund } from '@/app/api/billing/refunds/route'
import { issueRefund, recordPayment } from '@/lib/queries/patient-ledger'

const req = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const PAYMENT = { patientId: 'RD-0001', kind: 'receipt', mode: 'upi', reference: 'UTR412345678901', amountPaise: 50000 }
const REFUND = { patientId: 'RD-0001', mode: 'cash', amountPaise: 1000, reason: 'Discharged early' }

beforeEach(() => {
  role = 'frontdesk'
  vi.mocked(recordPayment).mockReset().mockResolvedValue({ ok: true, receiptNumber: 'RCT/26-27/000001', paymentId: 5 })
  vi.mocked(issueRefund).mockReset().mockResolvedValue({ ok: true, refundNumber: 'RFD/26-27/000001' })
})

describe('payments and refunds routes', () => {
  it('frontdesk can record a receipt but gets 403 on a refund', async () => {
    const res = await postPayment(req('/api/billing/payments', PAYMENT))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ receiptNumber: 'RCT/26-27/000001', paymentId: 5 })
    const refund = await postRefund(req('/api/billing/refunds', '{not json'))
    expect(refund.status).toBe(403)
    expect(await refund.json()).toEqual({ error: 'Forbidden' })
    expect(issueRefund).not.toHaveBeenCalled()
  })

  it.each(['pi', 'pharmacy', 'labs'])('%s is 403 on payments before the body is read', async (r) => {
    role = r
    const res = await postPayment(req('/api/billing/payments', '{not json'))
    expect(res.status).toBe(403)
    expect(recordPayment).not.toHaveBeenCalled()
  })

  it('a card number in the reference is a 400 with the authored message', async () => {
    const res = await postPayment(req('/api/billing/payments', { ...PAYMENT, mode: 'card', reference: '4111 1111 1111 1111' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'This looks like a card number. Enter the bank or UPI reference instead' })
    expect(recordPayment).not.toHaveBeenCalled()
  })

  it('payment errors map exactly', async () => {
    vi.mocked(recordPayment).mockResolvedValueOnce({ ok: false, error: 'patient_not_found' })
    const nf = await postPayment(req('/api/billing/payments', PAYMENT))
    expect([nf.status, await nf.json()]).toEqual([404, { error: 'Patient not found' }])
    vi.mocked(recordPayment).mockResolvedValueOnce({ ok: false, error: 'admission_mismatch' })
    const am = await postPayment(req('/api/billing/payments', PAYMENT))
    expect([am.status, await am.json()]).toEqual([400, { error: "That admission is not this patient's" }])
    vi.mocked(recordPayment).mockResolvedValueOnce({ ok: false, error: 'invoice_not_payable' })
    const np = await postPayment(req('/api/billing/payments', PAYMENT))
    expect([np.status, await np.json()]).toEqual([409, { error: 'Payments can only be taken against a finalised invoice of this patient' }])
  })

  it('refund: billing may refund; errors map exactly with the credit in rupees', async () => {
    role = 'billing'
    const ok = await postRefund(req('/api/billing/refunds', REFUND))
    expect([ok.status, await ok.json()]).toEqual([201, { refundNumber: 'RFD/26-27/000001' }])
    expect(issueRefund).toHaveBeenCalledWith(expect.objectContaining({ amountPaise: 1000 }), expect.objectContaining({ role: 'billing' }))
    vi.mocked(issueRefund).mockResolvedValueOnce({ ok: false, error: 'exceeds_credit', creditPaise: 123456 })
    const ex = await postRefund(req('/api/billing/refunds', REFUND))
    expect(ex.status).toBe(409)
    expect((await ex.json()).error).toMatch(/^Refund is more than the patient's credit of ₹\s?1,234\.56$/)
    vi.mocked(issueRefund).mockResolvedValueOnce({ ok: false, error: 'payment_mismatch' })
    const pm = await postRefund(req('/api/billing/refunds', REFUND))
    expect([pm.status, await pm.json()]).toEqual([400, { error: "That receipt is not this patient's" }])
    vi.mocked(issueRefund).mockResolvedValueOnce({ ok: false, error: 'patient_not_found' })
    expect((await postRefund(req('/api/billing/refunds', REFUND))).status).toBe(404)
  })

  it('a full receipt or refund number series is a 409 with a plain message', async () => {
    vi.mocked(recordPayment).mockResolvedValueOnce({ ok: false, error: 'series_exhausted' })
    const p = await postPayment(req('/api/billing/payments', PAYMENT))
    expect([p.status, await p.json()]).toEqual([409, { error: 'The receipt number series for this financial year is full' }])
    role = 'billing'
    vi.mocked(issueRefund).mockResolvedValueOnce({ ok: false, error: 'series_exhausted' })
    const r = await postRefund(req('/api/billing/refunds', REFUND))
    expect([r.status, await r.json()]).toEqual([409, { error: 'The refund number series for this financial year is full' }])
  })

  it('bad JSON is a 400; a deadlock is a 409', async () => {
    const bad = await postPayment(req('/api/billing/payments', '{not json'))
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'Invalid JSON' }])
    vi.mocked(recordPayment).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }))
    expect((await postPayment(req('/api/billing/payments', PAYMENT))).status).toBe(409)
  })
})
