import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'T', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patients', () => ({
  findLikelyDuplicatePatients: vi.fn(async () => [{ id: 'RD-0001', name: 'Asha Rao', dob: '1990-01-01', uhid: 'UH000001' }]),
  findPatientsByPhone: vi.fn(async () => [
    { id: 'RD-0001', name: 'Asha Rao', dob: '1990-01-01', uhid: 'UH000001' },
    { id: 'RD-0009', name: 'Asha R', dob: '1991-01-01', uhid: null },
  ]),
}))

import { GET } from '@/app/api/front-desk/patient-lookup/route'
import { findLikelyDuplicatePatients, findPatientsByPhone } from '@/lib/queries/patients'

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/front-desk/patient-lookup?${qs}`))

afterEach(() => { sessionRole = 'frontdesk'; vi.clearAllMocks() })

// Wave B P1-10
describe('GET /api/front-desk/patient-lookup', () => {
  it.each(['pi', 'pharmacy', 'billing', 'labs'] as const)('403s %s without querying', async (role) => {
    sessionRole = role
    const res = await get('name=Asha&dob=1990-01-01')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(findLikelyDuplicatePatients).not.toHaveBeenCalled()
  })

  it('400s without name+dob or a valid mobile', async () => {
    expect((await get('name=Asha')).status).toBe(400)
    expect((await get('phone=12345')).status).toBe(400)
  })

  it('merges name+dob and mobile matches, once per patient', async () => {
    const res = await get('name=Asha%20Rao&dob=1990-01-01&phone=98123%2000077')
    expect(res.status).toBe(200)
    expect(findPatientsByPhone).toHaveBeenCalledWith('+919812300077')
    expect(await res.json()).toEqual([
      { id: 'RD-0001', name: 'Asha Rao', dob: '1990-01-01', uhid: 'UH000001' },
      { id: 'RD-0009', name: 'Asha R', dob: '1991-01-01', uhid: null },
    ])
  })

  it('looks up by mobile alone', async () => {
    const res = await get('phone=%2B919812300077')
    expect(res.status).toBe(200)
    expect(findLikelyDuplicatePatients).not.toHaveBeenCalled()
  })
})
