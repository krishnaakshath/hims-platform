import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

// Wave C P1-11: PATCH /api/patients/[anonId]/demographics (admin-only name /
// DOB correction with an audited reason). Query, cache and audit mocked.
let sessionRole: Role = 'admin'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role: sessionRole, name: 'Test WC', userId: null } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/patient-profile', () => ({ correctPatientDemographics: vi.fn(async () => 'ok') }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/cache', () => ({
  invalidateCache: vi.fn(async () => undefined),
  invalidateCacheByPrefix: vi.fn(async () => undefined),
  patientDetailCacheKey: vi.fn((id: string) => `patients:detail:${id}`),
  patientListCacheKey: vi.fn(() => 'patients:list:all'),
  patientListCachePrefix: vi.fn(() => 'patients:list:'),
  workbookListCacheKey: vi.fn(() => 'workbook:list'),
}))

import { PATCH } from '@/app/api/patients/[anonId]/demographics/route'
import { correctPatientDemographics } from '@/lib/queries/patient-profile'
import { invalidateCache, invalidateCacheByPrefix } from '@/lib/cache'

const ctx = { params: Promise.resolve({ anonId: 'RD-0001' }) }
const req = (body: unknown) => new NextRequest('http://localhost/api/patients/RD-0001/demographics', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) })
const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

beforeEach(() => { vi.mocked(correctPatientDemographics).mockReset().mockResolvedValue('ok') })
afterEach(() => { sessionRole = 'admin'; signedIn = true; consoleSpy.mockClear() })

describe('PATCH /api/patients/[anonId]/demographics', () => {
  it('401s without a session', async () => {
    signedIn = false
    expect((await PATCH(req({}), ctx)).status).toBe(401)
  })

  it.each(['crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs'] as Role[])('403s %s before parsing', async (role) => {
    sessionRole = role
    const res = await PATCH(req('{not json'), ctx)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(correctPatientDemographics).not.toHaveBeenCalled()
  })

  it('corrects name and DOB with a reason and busts the patient caches', async () => {
    const res = await PATCH(req({ name: 'Asha Rao', dob: '1990-01-10', reason: 'Typo at registration' }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(correctPatientDemographics).toHaveBeenCalledWith('RD-0001', { name: 'Asha Rao', dob: '1990-01-10', reason: 'Typo at registration' }, expect.objectContaining({ role: 'admin' }))
    expect(invalidateCache).toHaveBeenCalledWith('patients:detail:RD-0001')
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith('patients:list:')
  })

  it.each([
    ['no reason', { name: 'Asha Rao' }],
    ['a too-short reason', { name: 'Asha Rao', reason: 'typo' }],
    ['neither field', { reason: 'Typo at registration' }],
    ['an unknown key', { name: 'Asha Rao', reason: 'Typo at registration', uhid: 'X' }],
    ['a future DOB', { dob: '2999-01-01', reason: 'Typo at registration' }],
    ['an Aadhaar-like number in the reason', { name: 'Asha Rao', reason: 'per card 2345 6789 0124' }],
  ])('400s %s without echoing the input', async (_label, body) => {
    const res = await PATCH(req(body), ctx)
    expect(res.status).toBe(400)
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/2345|Asha|2999/)
    expect(correctPatientDemographics).not.toHaveBeenCalled()
  })

  it('400s an unparseable body', async () => {
    expect((await PATCH(req('{not json'), ctx)).status).toBe(400)
  })

  it('404s an unknown patient', async () => {
    vi.mocked(correctPatientDemographics).mockResolvedValue('not_found')
    const res = await PATCH(req({ name: 'Asha Rao', reason: 'Typo at registration' }), ctx)
    expect(res.status).toBe(404)
  })

  it('400s a DOB that needs a guardian contact first', async () => {
    vi.mocked(correctPatientDemographics).mockResolvedValue('guardian_required')
    const res = await PATCH(req({ dob: '2015-01-01', reason: 'Typo at registration' }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A guardian contact is required for a patient under 18' })
  })

  it('409s a deadlock with the retry message', async () => {
    vi.mocked(correctPatientDemographics).mockRejectedValue(Object.assign(new Error('x'), { code: '40001' }))
    expect((await PATCH(req({ name: 'Asha Rao', reason: 'Typo at registration' }), ctx)).status).toBe(409)
  })

  it('500s other failures with a fixed message and logs only the pg code', async () => {
    vi.mocked(correctPatientDemographics).mockRejectedValue(Object.assign(new Error('update patients set name = Asha'), { code: '23514' }))
    const res = await PATCH(req({ name: 'Asha Rao', reason: 'Typo at registration' }), ctx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Update failed' })
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('Asha')
  })
})
