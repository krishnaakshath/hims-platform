// FHIR Condition mapping (SP6 Task 15 replaces the SP1 'no system' case, ruling 11): a `system`
// URI and `version` appear only when the diagnosis was coded from a loaded NON-SAMPLE code system;
// legacy free text keeps today's code+display coding with no system, and an empty code yields text
// only. Pure: rows are built here (the gather join is tests/lib/fhir/gather.test.ts).
import { describe, it, expect } from 'vitest'
import type { DiagnosisFhirRow } from '@/lib/fhir/gather'
import { codingFor, conditionToFhir, conditionsToFhir } from '@/lib/fhir/condition'

const CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category'
const VER_STATUS = 'http://terminology.hl7.org/CodeSystem/condition-ver-status'

function legacy(o: Partial<DiagnosisFhirRow> = {}): DiagnosisFhirRow {
  return {
    id: 7, patientId: 'RD-1', code: 'F32.1', description: o.code === '' ? 'Chest pain' : 'Depression', date: '2026-01-15',
    encounterId: null, codeId: null, codeSystemKind: null, codeDisplay: null, diagnosisType: null, codingStatus: 'uncoded', sequence: null,
    proposedByName: null, proposedAt: null, codedByName: null, codedAt: null, voidedAt: null, voidedByName: null, createdByName: null, createdAt: null,
    binding: null,
    ...o,
  }
}

function coded(o: Partial<DiagnosisFhirRow> = {}): DiagnosisFhirRow {
  return legacy({
    id: 11, code: 'E11.9', description: 'Diabetes (doctor wording)', encounterId: 5, codeId: 99, codeSystemKind: 'icd10',
    codeDisplay: 'Type 2 diabetes mellitus without complications', diagnosisType: 'primary', codingStatus: 'coded',
    binding: { kind: 'icd10', version: '2019', isSample: false },
    ...o,
  })
}

describe('conditionToFhir', () => {
  it('legacy free-text diagnosis has no system', () => {
    expect(conditionToFhir(legacy({ code: 'F32.1' })).code.coding).toEqual([{ code: 'F32.1', display: 'Depression' }])
    expect(conditionToFhir(legacy()).code.coding![0]).not.toHaveProperty('system')
    expect(conditionToFhir(legacy()).code.coding![0]).not.toHaveProperty('version')
  })

  it('an empty code yields text only', () => {
    const c = conditionToFhir(legacy({ code: '' }))
    expect(c.code).toEqual({ text: 'Chest pain' })
    expect(c.code).not.toHaveProperty('coding')
  })

  it('a code from a loaded ICD-10 system carries the WHO URI and version', () => {
    expect(conditionToFhir(coded({ binding: { kind: 'icd10', version: '2019', isSample: false } })).code.coding).toEqual([
      { system: 'http://hl7.org/fhir/sid/icd-10', version: '2019', code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' },
    ])
    expect(conditionToFhir(coded()).code.text).toBe('Diabetes (doctor wording)')
  })

  it('a sample code system never carries a system URI', () => {
    const coding = conditionToFhir(coded({ binding: { kind: 'icd10', version: 'SAMPLE-ICD10-0', isSample: true } })).code.coding!
    expect(coding[0].system).toBeUndefined()
    expect(coding[0].version).toBeUndefined()
    expect(coding).toEqual([{ code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' }])
  })

  it('SNOMED-coded conditions use http://snomed.info/sct; HBP never gets a system', () => {
    const snomed = conditionToFhir(coded({ code: '44054006', codeSystemKind: 'snomed', binding: { kind: 'snomed', version: '20260301', isSample: false } }))
    expect(snomed.code.coding).toEqual([{ system: 'http://snomed.info/sct', version: '20260301', code: '44054006', display: 'Type 2 diabetes mellitus without complications' }])
    expect(codingFor('SMP001A', 'Package', { kind: 'hbp', version: '2026', isSample: false })).toEqual([{ code: 'SMP001A', display: 'Package' }])
  })

  it('links the encounter and marks provisional', () => {
    const c = conditionToFhir(coded({ encounterId: 5, diagnosisType: 'provisional', codingStatus: 'proposed' }))
    expect(c.encounter).toEqual({ reference: 'Encounter/encounter-5' })
    expect(c.verificationStatus).toEqual({ coding: [{ system: VER_STATUS, code: 'provisional' }] })
    expect(c.category).toEqual([{ coding: [{ system: CATEGORY, code: 'encounter-diagnosis' }] }])
    expect(conditionToFhir(coded({ diagnosisType: 'secondary' })).verificationStatus).toEqual({ coding: [{ system: VER_STATUS, code: 'confirmed' }] })
  })

  it('a legacy row is a problem-list item with no encounter and no verification status', () => {
    const c = conditionToFhir(legacy())
    expect(c).toEqual({
      resourceType: 'Condition',
      id: 'condition-7',
      subject: { reference: 'Patient/RD-1' },
      category: [{ coding: [{ system: CATEGORY, code: 'problem-list-item' }] }],
      code: { text: 'Depression', coding: [{ code: 'F32.1', display: 'Depression' }] },
      recordedDate: '2026-01-15',
    })
  })

  it('maps a null date to a null recordedDate; conditionsToFhir maps a list', () => {
    expect(conditionToFhir(legacy({ date: null })).recordedDate).toBeNull()
    expect(conditionsToFhir([legacy(), coded()]).map((c) => c.id)).toEqual(['condition-7', 'condition-11'])
  })
})

describe('codingFor', () => {
  it('is undefined for an empty code and omits a null display', () => {
    expect(codingFor('', 'x', null)).toBeUndefined()
    expect(codingFor('ZZ00000', null, null)).toEqual([{ code: 'ZZ00000' }])
  })
})
