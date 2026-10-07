import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'admin'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role, name: 'Probe User', userId: 7 })),
}))
vi.mock('@/lib/queries/billing-settings', () => ({
  updateBillingSettings: vi.fn(),
  setRuleConfig: vi.fn(),
  updatePayerBillingFlags: vi.fn(),
}))

import { PUT as putSettings } from '@/app/api/billing/settings/route'
import { PUT as putRule } from '@/app/api/billing/rules/[code]/route'
import { PUT as putPayer } from '@/app/api/billing/payers/[id]/route'
import { setRuleConfig, updateBillingSettings, updatePayerBillingFlags } from '@/lib/queries/billing-settings'

const send = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

const SETTINGS = {
  legalName: 'Sunrise Hospital', gstin: '29AAGCB7383J1Z4', stateCode: 'IN-KA', address: null, placeOfSupplyMode: 'location_of_service',
  consultationWindowDays: 30, ipdDepositThresholdPaise: 0, roomRentServiceId: null, pharmacyGstRateBp: 500, pharmacyHsn: '3004',
}

beforeEach(() => {
  role = 'admin'
  vi.mocked(updateBillingSettings).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(setRuleConfig).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(updatePayerBillingFlags).mockReset().mockResolvedValue(true)
})

describe('PUT /api/billing/settings', () => {
  it.each(['crc', 'billing', 'frontdesk', 'pi', 'pharmacy', 'labs'])('%s gets 403 and the query is never called', async (r) => {
    role = r
    const res = await putSettings(send('/api/billing/settings', SETTINGS))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(updateBillingSettings).not.toHaveBeenCalled()
  })

  it('admin saves settings: 200 { ok: true }', async () => {
    const res = await putSettings(send('/api/billing/settings', SETTINGS))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(updateBillingSettings).toHaveBeenCalledWith(expect.objectContaining({ legalName: 'Sunrise Hospital' }), expect.objectContaining({ role: 'admin' }))
  })

  it('a lowercase GSTIN is accepted and stored uppercase', async () => {
    const res = await putSettings(send('/api/billing/settings', { ...SETTINGS, gstin: '29aagcb7383j1z4' }))
    expect(res.status).toBe(200)
    expect(vi.mocked(updateBillingSettings).mock.calls[0][0].gstin).toBe('29AAGCB7383J1Z4')
  })

  it('admin PUT with a GSTIN from another state is a 400 with the authored message', async () => {
    const res = await putSettings(send('/api/billing/settings', { ...SETTINGS, stateCode: 'IN-TN' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The GSTIN does not belong to the selected state' })
    expect(updateBillingSettings).not.toHaveBeenCalled()
  })

  it('bad JSON is a 400, never a 500', async () => {
    const res = await putSettings(send('/api/billing/settings', '{not json'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('an unknown key collapses to the generic message (input never echoed)', async () => {
    const res = await putSettings(send('/api/billing/settings', { ...SETTINGS, secret: 'x' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid billing settings' })
  })

  it('a room-rent service outside the Room rent category is a 400', async () => {
    vi.mocked(updateBillingSettings).mockResolvedValue({ ok: false, error: 'room_rent_service_invalid' })
    const res = await putSettings(send('/api/billing/settings', { ...SETTINGS, roomRentServiceId: 9 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Choose a room-rent service from the Room rent category' })
  })

  it('a deadlock is a 409 with the retry message; anything else a generic 500', async () => {
    vi.mocked(updateBillingSettings).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }))
    const res = await putSettings(send('/api/billing/settings', SETTINGS))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Another change was being saved at the same time; please try again' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(updateBillingSettings).mockRejectedValueOnce(Object.assign(new Error('secret detail'), { code: '23514', constraint: 'billing_settings_singleton' }))
    const res2 = await putSettings(send('/api/billing/settings', SETTINGS))
    expect(res2.status).toBe(500)
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret detail')
    expect(JSON.stringify(spy.mock.calls)).toContain('billing_settings_singleton')
    spy.mockRestore()
  })
})

describe('PUT /api/billing/rules/[code]', () => {
  it('admin updates a configurable rule', async () => {
    const res = await putRule(send('/api/billing/rules/duplicate_charge', { enabled: true, severity: 'warn' }), ctx({ code: 'duplicate_charge' }))
    expect(res.status).toBe(200)
    expect(setRuleConfig).toHaveBeenCalledWith('duplicate_charge', { enabled: true, severity: 'warn' }, expect.objectContaining({ role: 'admin' }))
  })

  it('PUT /api/billing/rules/price_unresolved is a 400: not configurable', async () => {
    vi.mocked(setRuleConfig).mockResolvedValue({ ok: false, error: 'not_configurable' })
    const res = await putRule(send('/api/billing/rules/price_unresolved', { enabled: false, severity: null }), ctx({ code: 'price_unresolved' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'This rule cannot be changed' })
  })

  it('PUT /api/billing/rules/nope is a 404', async () => {
    const res = await putRule(send('/api/billing/rules/nope', { enabled: false, severity: null }), ctx({ code: 'nope' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Unknown rule' })
    expect(setRuleConfig).not.toHaveBeenCalled()
  })

  it('billing (read-only on rules) is 403', async () => {
    role = 'billing'
    const res = await putRule(send('/api/billing/rules/duplicate_charge', { enabled: false, severity: null }), ctx({ code: 'duplicate_charge' }))
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/billing/payers/[id]', () => {
  it('admin saves payer flags, uppercasing a lowercase GSTIN', async () => {
    const res = await putPayer(send('/api/billing/payers/3', { requiresPreauth: true, gstin: '27aapfu0939f1zv', stateCode: 'IN-MH' }), ctx({ id: '3' }))
    expect(res.status).toBe(200)
    expect(updatePayerBillingFlags).toHaveBeenCalledWith(3, { requiresPreauth: true, gstin: '27AAPFU0939F1ZV', stateCode: 'IN-MH' }, expect.anything())
  })
  it('a bad id is a 400 and a missing payer a 404', async () => {
    const body = { requiresPreauth: false, gstin: null, stateCode: null }
    expect((await putPayer(send('/api/billing/payers/x', body), ctx({ id: 'x' }))).status).toBe(400)
    vi.mocked(updatePayerBillingFlags).mockResolvedValue(false)
    const res = await putPayer(send('/api/billing/payers/3', body), ctx({ id: '3' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Payer not found' })
  })
  it('signed-out callers get the session response', async () => {
    const { requireSession } = await import('@/lib/auth')
    vi.mocked(requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) as never)
    expect((await putPayer(send('/api/billing/payers/3', {}), ctx({ id: '3' }))).status).toBe(401)
  })
})
