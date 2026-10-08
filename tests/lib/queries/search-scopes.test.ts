import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/queries/patients', () => ({
  listPatientsWithStatus: vi.fn(async () => [
    { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH000123', phone: '+919876543210' },
    { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH000123', phone: '+919876543210' },
    { id: 'RD-0002', name: 'Vikram Shah', uhid: null, phone: null },
  ]),
}))
vi.mock('@/lib/queries/trials', () => ({ listAllTrials: vi.fn(async () => []) }))
vi.mock('@/lib/queries/form-templates', () => ({ listFormTemplates: vi.fn(async () => []) }))
vi.mock('@/lib/queries/tariff', () => ({
  listServices: vi.fn(async () => [{ id: 9, code: 'CONS-GEN', name: 'General consultation', departmentName: 'General Medicine' }]),
}))

import { searchAll } from '@/lib/queries/search'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listServices } from '@/lib/queries/tariff'

const NONE = { patients: false, trials: false, formTemplates: false, services: false }

beforeEach(() => vi.clearAllMocks())

describe('searchAll scopes (Wave B P1-24)', () => {
  it('matches a patient by mobile number (any common format) when phone matching is allowed', async () => {
    for (const q of ['9876543210', '+91 98765 43210', '98765']) {
      const r = await searchAll(q, { ...NONE, patients: true }, { matchPhone: true })
      expect(r.patients.map((p) => p.id), q).toEqual(['RD-0001'])
    }
  })

  // Wave G: a role that may not see mobiles must not be able to probe them either.
  it('never matches by mobile unless phone matching is allowed', async () => {
    for (const q of ['9876543210', '+91 98765 43210', '98765']) {
      const r = await searchAll(q, { ...NONE, patients: true })
      expect(r.patients, q).toEqual([])
    }
  })

  it('does not phone-match a short digit run (e.g. part of an anon id)', async () => {
    const r = await searchAll('0002', { ...NONE, patients: true }, { matchPhone: true })
    expect(r.patients.map((p) => p.id)).toEqual(['RD-0002'])
  })

  it('matches a full UHID and shows it, never the phone, in the result', async () => {
    const r = await searchAll('uh000123', { ...NONE, patients: true })
    expect(r.patients).toEqual([{ id: 'RD-0001', label: 'Asha Rao', detail: 'RD-0001 · UH000123', href: '/patients/RD-0001' }])
  })

  it('searches the tariff service catalogue only with the services scope', async () => {
    const r = await searchAll('consult', { ...NONE, services: true })
    expect(r.services).toEqual([{ id: '9', label: 'General consultation', detail: 'CONS-GEN · General Medicine', href: '/tariffs/services/9' }])
    expect(listServices).toHaveBeenCalledWith(expect.objectContaining({ q: 'consult' }))
    expect(listPatientsWithStatus).not.toHaveBeenCalled()
    expect(r.patients).toEqual([])
  })

  // Wave G: lookup-only roles land on the price lookup, not the tariff editor.
  it('uses the caller-supplied service link', async () => {
    const r = await searchAll('consult', { ...NONE, services: true }, { serviceHref: (id) => `/price-lookup?serviceId=${id}` })
    expect(r.services[0].href).toBe('/price-lookup?serviceId=9')
  })

  it('ranks an exact UHID or chart id hit before name matches', async () => {
    vi.mocked(listPatientsWithStatus).mockResolvedValueOnce([
      { id: 'RD-0003', name: 'Uh Ming', uhid: 'UH000999', phone: null },
      { id: 'RD-0004', name: 'Zara Iyer', uhid: 'UH', phone: null },
    ] as never)
    const r = await searchAll('uh', { ...NONE, patients: true })
    expect(r.patients.map((p) => p.id)).toEqual(['RD-0004', 'RD-0003'])
  })

  it('never loads the service catalogue without the services scope', async () => {
    const r = await searchAll('consult', { ...NONE, patients: true })
    expect(listServices).not.toHaveBeenCalled()
    expect(r.services).toEqual([])
  })
})
