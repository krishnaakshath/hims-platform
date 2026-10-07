import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/queries/patients', () => ({
  listPatientsWithStatus: vi.fn(async () => [
    { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' },
    { id: 'RD-0002', name: 'Ravi Kumar', uhid: null },
  ]),
}))
vi.mock('@/lib/queries/trials', () => ({ listAllTrials: vi.fn(async () => []) }))
vi.mock('@/lib/queries/form-templates', () => ({ listFormTemplates: vi.fn(async () => []) }))

import { searchAll } from '@/lib/queries/search'
import { listPatientsWithStatus } from '@/lib/queries/patients'

const ALL = { patients: true, trials: true, formTemplates: true, services: false }

describe('searchAll by UHID', () => {
  it('matches a UHID prefix and the exact UHID, case-insensitively', async () => {
    for (const q of ['uh0000', 'UH00000042', 'uh00000042']) {
      const r = await searchAll(q, ALL)
      expect(r.patients.map((p) => p.id), q).toEqual(['RD-0001'])
    }
  })
  it('does not match a UHID by substring in the middle', async () => {
    expect((await searchAll('00042', ALL)).patients).toEqual([])
  })
  it('shows the UHID in the result detail, only the id when none', async () => {
    const r = await searchAll('', ALL)
    expect(r.patients).toEqual([])
    const a = (await searchAll('RD-0001', ALL)).patients[0]
    expect(a.detail).toBe('RD-0001 · UH00000042')
    expect(Object.keys(a).sort()).toEqual(['detail', 'href', 'id', 'label'])
    expect((await searchAll('RD-0002', ALL)).patients[0].detail).toBe('RD-0002')
  })
  it('does not load the patient list without the patients scope', async () => {
    vi.mocked(listPatientsWithStatus).mockClear()
    const r = await searchAll('UH0000', { patients: false, trials: false, formTemplates: false, services: false })
    expect(r.patients).toEqual([])
    expect(listPatientsWithStatus).not.toHaveBeenCalled()
  })
})
