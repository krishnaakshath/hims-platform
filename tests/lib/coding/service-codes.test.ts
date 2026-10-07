// SP6 Task 14: service-category <-> code-kind compatibility and the SP4 charge-code check (pure).
import { describe, it, expect } from 'vitest'
import {
  SERVICE_CODE_KINDS_BY_CATEGORY, chargeProcedureCodeProblems, isMappableServiceCategory, serviceCodeProblems,
} from '@/lib/coding/service-codes'

describe('SERVICE_CODE_KINDS_BY_CATEGORY', () => {
  it('maps exactly the four code-carrying categories', () => {
    expect(SERVICE_CODE_KINDS_BY_CATEGORY).toEqual({
      procedure: ['icd10pcs', 'snomed', 'hbp'],
      package: ['hbp'],
      investigation_lab: ['loinc'],
      investigation_imaging: ['snomed', 'icd10pcs'],
    })
    expect(isMappableServiceCategory('package')).toBe(true)
    expect(isMappableServiceCategory('consultation')).toBe(false)
    expect(isMappableServiceCategory('room_rent')).toBe(false)
  })
})

describe('serviceCodeProblems', () => {
  it('a package takes only HBP codes; a consultation takes none', () => {
    expect(serviceCodeProblems('package', [{ kind: 'icd10pcs', code: 'ZZ00000' }])).toEqual(['ICD-10-PCS codes do not fit a package service'])
    expect(serviceCodeProblems('consultation', [{ kind: 'hbp', code: 'SMP001A' }])).toEqual(['This kind of service cannot carry procedure codes'])
  })

  it('accepts fitting kinds and names each bad kind once', () => {
    expect(serviceCodeProblems('procedure', [{ kind: 'icd10pcs', code: 'ZZ00000' }, { kind: 'snomed', code: '1' }, { kind: 'hbp', code: 'SMP001A' }])).toEqual([])
    expect(serviceCodeProblems('investigation_lab', [{ kind: 'loinc', code: '2345-7' }])).toEqual([])
    expect(serviceCodeProblems('investigation_lab', [
      { kind: 'icd10', code: 'E11.9' }, { kind: 'icd10', code: 'E11.8' }, { kind: 'snomed', code: '1' },
    ])).toEqual(['ICD-10 codes do not fit a lab investigation service', 'SNOMED CT codes do not fit a lab investigation service'])
    expect(serviceCodeProblems('investigation_imaging', [{ kind: 'loinc', code: '2345-7' }])).toEqual(['LOINC codes do not fit an imaging investigation service'])
  })

  it('an empty map is always fine (clearing a mapping)', () => {
    expect(serviceCodeProblems('consultation', [])).toEqual([])
    expect(serviceCodeProblems('package', [])).toEqual([])
  })
})

describe('chargeProcedureCodeProblems (SP4 hook)', () => {
  it('SP4 check: unmapped services are unconstrained; mapped ones must match', () => {
    expect(chargeProcedureCodeProblems([], [{ kind: 'hbp', code: 'X1' }])).toEqual([])
    expect(chargeProcedureCodeProblems([{ kind: 'hbp', code: 'SMP001A' }], [{ kind: 'hbp', code: 'SMP002A' }])).toEqual(['SMP002A is not a procedure code mapped to this service'])
  })

  it('matches by kind and normalised code, and reports each unmapped request', () => {
    const mapped = [{ kind: 'hbp' as const, code: 'SMP001A' }, { kind: 'icd10pcs' as const, code: 'ZZ00000' }]
    expect(chargeProcedureCodeProblems(mapped, [{ kind: 'hbp', code: ' smp001a ' }, { kind: 'icd10pcs', code: 'ZZ00000' }])).toEqual([])
    expect(chargeProcedureCodeProblems(mapped, [{ kind: 'snomed', code: 'SMP001A' }, { kind: 'hbp', code: 'SMP003A' }])).toEqual([
      'SMP001A is not a procedure code mapped to this service', 'SMP003A is not a procedure code mapped to this service',
    ])
    expect(chargeProcedureCodeProblems(mapped, [])).toEqual([])
  })
})
