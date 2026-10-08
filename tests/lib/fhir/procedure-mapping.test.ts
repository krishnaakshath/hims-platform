// FHIR Procedure mapping (SP6 Task 15). Pure.
import { describe, it, expect } from 'vitest'
import type { ProcedureFhirRow } from '@/lib/fhir/gather'
import { procedureToFhir, proceduresToFhir } from '@/lib/fhir/procedure'

function proc(o: Partial<ProcedureFhirRow> = {}): ProcedureFhirRow {
  return {
    id: 21, encounterId: 5, patientId: 'RD-1', description: 'Knee arthroscopy', codeId: 3, codeSystemKind: 'icd10pcs', code: '0SJC4ZZ',
    codeDisplay: 'Inspection of right knee joint, percutaneous endoscopic approach', codingStatus: 'coded', performedOn: '2099-03-01',
    performedByProviderId: 2, serviceId: null, sequence: null, createdByName: 'Coder', createdAt: new Date('2099-03-01T00:00:00Z'),
    proposedByName: null, proposedAt: null, codedByName: 'Coder', codedAt: null, voidedAt: null, voidedByName: null,
    binding: { kind: 'icd10pcs', version: '2026', isSample: false }, performedByName: 'Dr. Rao',
    ...o,
  }
}

describe('procedureToFhir', () => {
  it('maps a PCS-coded procedure with the CMS URI', () => {
    expect(procedureToFhir(proc())).toEqual({
      resourceType: 'Procedure',
      id: 'procedure-21',
      status: 'completed',
      subject: { reference: 'Patient/RD-1' },
      encounter: { reference: 'Encounter/encounter-5' },
      code: {
        text: 'Knee arthroscopy',
        coding: [{ system: 'http://www.cms.gov/Medicare/Coding/ICD10', version: '2026', code: '0SJC4ZZ', display: 'Inspection of right knee joint, percutaneous endoscopic approach' }],
      },
      performedDateTime: '2099-03-01',
      performer: [{ actor: { display: 'Dr. Rao' } }],
    })
  })

  it('an uncoded procedure is text only; a sample or HBP code carries no system; no performer when unknown', () => {
    const free = procedureToFhir(proc({ code: null, codeId: null, codeSystemKind: null, codeDisplay: null, binding: null, performedByName: null, codingStatus: 'uncoded' }))
    expect(free.code).toEqual({ text: 'Knee arthroscopy' })
    expect(free).not.toHaveProperty('performer')
    expect(procedureToFhir(proc({ binding: { kind: 'icd10pcs', version: 'SAMPLE-PCS-0', isSample: true } })).code.coding![0]).not.toHaveProperty('system')
    expect(procedureToFhir(proc({ code: 'SMP001A', codeSystemKind: 'hbp', codeDisplay: null, binding: { kind: 'hbp', version: '2026', isSample: false } })).code.coding)
      .toEqual([{ code: 'SMP001A' }])
    expect(proceduresToFhir([proc(), proc({ id: 22 })]).map((p) => p.id)).toEqual(['procedure-21', 'procedure-22'])
  })
})
