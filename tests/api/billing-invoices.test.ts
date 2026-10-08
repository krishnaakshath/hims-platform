import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let role = 'billing'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: 7 })) }))
vi.mock('@/lib/queries/invoices', () => ({
  createDraftInvoice: vi.fn(), discardDraftInvoice: vi.fn(), finaliseInvoice: vi.fn(), cancelInvoice: vi.fn(),
}))

import { POST as createDraft } from '@/app/api/billing/invoices/route'
import { POST as finalise } from '@/app/api/billing/invoices/[id]/finalise/route'
import { POST as discard } from '@/app/api/billing/invoices/[id]/discard/route'
import { POST as cancel } from '@/app/api/billing/invoices/[id]/cancel/route'
import { cancelInvoice, createDraftInvoice, discardDraftInvoice, finaliseInvoice } from '@/lib/queries/invoices'

const req = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const call = {
  draft: (body: unknown) => createDraft(req('/api/billing/invoices', body)),
  finalise: (body: unknown, id = '4') => finalise(req(`/api/billing/invoices/${id}/finalise`, body), ctx(id)),
  discard: (body: unknown, id = '4') => discard(req(`/api/billing/invoices/${id}/discard`, body), ctx(id)),
  cancel: (body: unknown, id = '4') => cancel(req(`/api/billing/invoices/${id}/cancel`, body), ctx(id)),
}

beforeEach(() => {
  role = 'billing'
  vi.mocked(createDraftInvoice).mockReset().mockResolvedValue({ ok: true, invoiceId: 12 })
  vi.mocked(discardDraftInvoice).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(finaliseInvoice).mockReset().mockResolvedValue({ ok: true, invoiceNumber: 'INV/26-27/000001' })
  vi.mocked(cancelInvoice).mockReset().mockResolvedValue({ ok: true, creditNoteNumber: 'CRN/26-27/000001' })
})

describe('invoice routes', () => {
  it('crc finalise and cancel are 403 before parse; crc may draft and discard', async () => {
    role = 'crc'
    for (const res of [await call.finalise('{not json'), await call.cancel('{not json')]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(finaliseInvoice).not.toHaveBeenCalled()
    expect((await call.draft({ lineIds: [1, 2] })).status).toBe(201)
    expect((await call.discard({})).status).toBe(200)
  })

  it.each(['frontdesk', 'pi', 'pharmacy', 'labs'])('%s is 403 on every invoice route', async (r) => {
    role = r
    for (const res of [await call.draft('{x'), await call.finalise('{x'), await call.discard('{x'), await call.cancel('{x')]) expect(res.status).toBe(403)
    expect(cancelInvoice).not.toHaveBeenCalled()
  })

  it('successes: 201 { invoiceId }, 200 { invoiceNumber }, 200 { ok }, 200 { creditNoteNumber }', async () => {
    const d = await call.draft({ lineIds: [3] })
    expect(d.status).toBe(201)
    expect(await d.json()).toEqual({ invoiceId: 12 })
    expect(createDraftInvoice).toHaveBeenCalledWith([3], expect.objectContaining({ role: 'billing' }))
    expect(await (await call.finalise({})).json()).toEqual({ invoiceNumber: 'INV/26-27/000001' })
    expect(finaliseInvoice).toHaveBeenCalledWith(4, expect.objectContaining({ role: 'billing' }))
    expect(await (await call.discard({})).json()).toEqual({ ok: true })
    const c = await call.cancel({ reason: 'Wrong patient' })
    expect(c.status).toBe(200)
    expect(await c.json()).toEqual({ creditNoteNumber: 'CRN/26-27/000001' })
    expect(cancelInvoice).toHaveBeenCalledWith(4, 'Wrong patient', expect.objectContaining({ role: 'billing' }))
  })

  it.each([
    ['lines_not_found', 404, 'Charge lines not found'],
    ['lines_not_available', 409, 'Some lines are already invoiced or voided'],
    ['mixed_lines', 400, 'Lines on one invoice must share the patient, the visit or stay, and the payer'],
  ] as const)('draft %s → %i', async (error, status, message) => {
    vi.mocked(createDraftInvoice).mockResolvedValue({ ok: false, error })
    const res = await call.draft({ lineIds: [1] })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
  })

  it.each([
    ['not_found', 404, 'Invoice not found'],
    ['not_draft', 409, 'Only a draft invoice can be changed'],
    ['empty', 409, 'This draft has no lines'],
    ['settings_incomplete', 409, 'Set the hospital legal name and state in Billing rules & settings before finalising'],
    ['taxable_without_gstin', 409, 'This bill has taxable lines but no hospital GSTIN is set'],
    ['series_exhausted', 409, 'The invoice number series for this financial year is full'],
  ] as const)('finalise %s → %i', async (error, status, message) => {
    vi.mocked(finaliseInvoice).mockResolvedValue({ ok: false, error })
    const res = await call.finalise({})
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
  })

  it('discard and cancel errors map exactly', async () => {
    vi.mocked(discardDraftInvoice).mockResolvedValue({ ok: false, error: 'not_draft' })
    expect(await (await call.discard({})).json()).toEqual({ error: 'Only a draft invoice can be changed' })
    vi.mocked(discardDraftInvoice).mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await call.discard({})).status).toBe(404)
    vi.mocked(cancelInvoice).mockResolvedValue({ ok: false, error: 'not_finalised' })
    const c = await call.cancel({ reason: 'Wrong patient' })
    expect(c.status).toBe(409)
    expect(await c.json()).toEqual({ error: 'Only a finalised invoice can be cancelled' })
    vi.mocked(cancelInvoice).mockResolvedValue({ ok: false, error: 'not_found' })
    expect(await (await call.cancel({ reason: 'Wrong patient' })).json()).toEqual({ error: 'Invoice not found' })
  })

  // SP7 (ruling 2)
  it('an invoice on a submitted claim is a 409 with the plain message', async () => {
    vi.mocked(cancelInvoice).mockResolvedValue({ ok: false, error: 'on_claim' })
    const c = await call.cancel({ reason: 'Wrong patient' })
    expect(c.status).toBe(409)
    expect(await c.json()).toEqual({ error: 'This invoice is on a submitted insurance claim; withdraw the claim or record its outcome before cancelling' })
  })
  // end SP7

  it('bodies are strict; bad ids and bad JSON are 400s', async () => {
    expect((await call.finalise({ extra: 1 })).status).toBe(400)
    expect((await call.discard({ extra: 1 })).status).toBe(400)
    expect((await call.cancel({ reason: 'no' })).status).toBe(400)
    expect((await call.draft({ lineIds: [] })).status).toBe(400)
    expect(await (await call.draft({ lineIds: [1, 1] })).json()).toEqual({ error: 'Each line can be listed only once' })
    expect((await call.finalise({}, 'abc')).status).toBe(400)
    const bad = await call.finalise('{not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Invalid JSON' })
    expect(finaliseInvoice).not.toHaveBeenCalled()
  })

  it('a deadlock is a 409 with the retry message', async () => {
    vi.mocked(finaliseInvoice).mockRejectedValue(Object.assign(new Error('x'), { code: '40001' }))
    const res = await call.finalise({})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Another change was being saved at the same time; please try again' })
  })
})
