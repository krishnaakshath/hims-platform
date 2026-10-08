import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'rcm'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: null })) }))
vi.mock('@/lib/queries/rcm-payers', () => ({
  createPayerWithProfile: vi.fn(async () => ({ ok: true, value: { payerId: 9 } })),
  upsertPayerProfile: vi.fn(async () => ({ ok: true, value: null })),
  setPayerContacts: vi.fn(async () => ({ ok: true, value: null })),
  setPayerNetworks: vi.fn(async () => ({ ok: false, error: 'payer_kind_invalid' })),
  setDocumentRequirements: vi.fn(async () => ({ ok: true, value: null })),
  updateHospitalIdentifiers: vi.fn(async () => ({ ok: true, value: null })),
}))

import { POST as postPayer } from '@/app/api/rcm/payers/route'
import { PUT as putProfile } from '@/app/api/rcm/payers/[id]/route'
import { PUT as putNetworks } from '@/app/api/rcm/payers/[id]/networks/route'
import { PUT as putSettings } from '@/app/api/rcm/settings/route'
import { createPayerWithProfile, upsertPayerProfile, updateHospitalIdentifiers } from '@/lib/queries/rcm-payers'

const send = (method: string, path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const PROFILE = {
  kind: 'insurer', defaultChannel: 'portal', empanelmentStatus: 'empanelled', preauthSlaHours: 1, claimSettlementSlaDays: 30,
  queryResponseDays: 7, submissionWindowDays: 15, requiresAbha: false, requiresPreauthForIpd: true, active: true,
}

beforeEach(() => { sessionRole = 'rcm'; vi.clearAllMocks() })

describe('/api/rcm/payers and /api/rcm/settings', () => {
  it('billing gets 403 on POST /api/rcm/payers before the body is read', async () => {
    sessionRole = 'billing'
    const res = await postPayer(send('POST', '/api/rcm/payers', '{not json'))
    expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(createPayerWithProfile).not.toHaveBeenCalled()
  })
  it('rcm creates a payer: 201 with the id', async () => {
    const res = await postPayer(send('POST', '/api/rcm/payers', { ...PROFILE, name: 'Star Health', code: 'STAR' }))
    expect(res.status).toBe(201); expect(await res.json()).toEqual({ payerId: 9 })
  })
  it('rcm gets 403 on PUT /api/rcm/settings; admin gets 200', async () => {
    const body = { rohiniId: '8900080123456', hfrId: 'IN2910000123' }
    expect((await putSettings(send('PUT', '/api/rcm/settings', body))).status).toBe(403)
    expect(updateHospitalIdentifiers).not.toHaveBeenCalled()
    sessionRole = 'admin'
    expect((await putSettings(send('PUT', '/api/rcm/settings', body))).status).toBe(200)
  })
  it('a bad GSTIN is a 400 with the authored message; bad JSON and a bad id are 400s', async () => {
    const res = await putProfile(send('PUT', '/api/rcm/payers/3', { ...PROFILE, gstin: 'NOTAGSTIN' }), ctx('3'))
    expect(res.status).toBe(400); expect(await res.json()).toEqual({ error: 'Enter a valid 15-character GSTIN' })
    expect(await (await putProfile(send('PUT', '/api/rcm/payers/3', '{not json'), ctx('3'))).json()).toEqual({ error: 'Invalid JSON' })
    expect((await putProfile(send('PUT', '/api/rcm/payers/x', PROFILE), ctx('x'))).status).toBe(400)
    expect(upsertPayerProfile).not.toHaveBeenCalled()
  })
  it('maps a query refusal to its catalogue status and message', async () => {
    const res = await putNetworks(send('PUT', '/api/rcm/payers/3/networks', { tpaPayerIds: [4] }), ctx('3'))
    expect(res.status).toBe(400); expect(await res.json()).toEqual({ error: 'Choose an insurer for the insurer field and a TPA for the TPA field' })
  })
  it('a deadlock is a 409 with the retry message', async () => {
    vi.mocked(upsertPayerProfile).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }))
    const res = await putProfile(send('PUT', '/api/rcm/payers/3', PROFILE), ctx('3'))
    expect(res.status).toBe(409); expect((await res.json()).error).toMatch(/try again/)
  })
})
