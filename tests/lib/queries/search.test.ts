import { describe, it, expect, vi } from 'vitest'
import { searchAll } from '@/lib/queries/search'
import * as trialsQ from '@/lib/queries/trials'
import * as formsQ from '@/lib/queries/form-templates'
import * as patientsQ from '@/lib/queries/patients'

const ALL = { patients: true, trials: true, formTemplates: true }

describe('searchAll', () => {
  it('returns empty results for a blank query', async () => {
    const results = await searchAll('   ', ALL)
    expect(results.patients).toEqual([])
    expect(results.trials).toEqual([])
    expect(results.formTemplates).toEqual([])
  })

  it('finds a seeded patient by anonymous id', async () => {
    const results = await searchAll('RD-0001', ALL)
    expect(results.patients.some((p) => p.id === 'RD-0001')).toBe(true)
  })

  it('finds a seeded patient by name, case-insensitively', async () => {
    const results = await searchAll('maria', ALL)
    expect(results.patients.some((p) => p.label.toLowerCase().includes('maria'))).toBe(true)
  })

  it('finds a seeded trial by condition', async () => {
    const results = await searchAll('depressive', ALL)
    expect(results.trials.length).toBeGreaterThan(0)
  })

  it('returns no results for a query that matches nothing', async () => {
    const results = await searchAll('zzzznonexistentzzzz', ALL)
    expect(results.patients).toEqual([])
    expect(results.trials).toEqual([])
    expect(results.formTemplates).toEqual([])
  })

  it('with only the patients scope never loads trials or templates', async () => {
    const trialsSpy = vi.spyOn(trialsQ, 'listAllTrials')
    const formsSpy = vi.spyOn(formsQ, 'listFormTemplates')
    const results = await searchAll('depressive', { patients: true, trials: false, formTemplates: false })
    expect(trialsSpy).not.toHaveBeenCalled()
    expect(formsSpy).not.toHaveBeenCalled()
    expect(results.trials).toEqual([])
    expect(results.formTemplates).toEqual([])
    trialsSpy.mockRestore()
    formsSpy.mockRestore()
  })

  it('with no patients scope never loads patients and returns []', async () => {
    const patientsSpy = vi.spyOn(patientsQ, 'listPatientsWithStatus')
    const results = await searchAll('RD-0001', { patients: false, trials: true, formTemplates: true })
    expect(patientsSpy).not.toHaveBeenCalled()
    expect(results.patients).toEqual([])
    patientsSpy.mockRestore()
  })

  // listPatientsWithStatus is a patient x screening join: a patient screened
  // for two trials comes back twice. Search lists each patient once.
  it('returns one row per patient even when the patient has several screenings', async () => {
    type Row = Awaited<ReturnType<typeof patientsQ.listPatientsWithStatus>>[number]
    const row = (id: string, name: string, trialId: string) => ({ id, name, trialId } as unknown as Row)
    const patientsSpy = vi.spyOn(patientsQ, 'listPatientsWithStatus').mockResolvedValueOnce([
      row('RD-DUP1', 'Dupe Probe', 'trial-a'),
      row('RD-DUP1', 'Dupe Probe', 'trial-b'),
      row('RD-DUP2', 'Dupe Probe Two', 'trial-a'),
    ])
    const results = await searchAll('dupe probe', { patients: true, trials: false, formTemplates: false })
    expect(results.patients.map((p) => p.id)).toEqual(['RD-DUP1', 'RD-DUP2'])
    patientsSpy.mockRestore()
  })
})
