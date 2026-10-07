// FHIR Encounter mapping (SP6 Task 15). Pure.
import { describe, it, expect } from 'vitest'
import type { EncounterFhirRow } from '@/lib/fhir/gather'
import { encounterToFhir, encountersToFhir } from '@/lib/fhir/encounter'

function enc(o: Partial<EncounterFhirRow> = {}): EncounterFhirRow {
  return {
    id: 5, patientId: 'RD-1', encounterType: 'ipd', visitType: 'new', status: 'completed', encounterDate: '2099-03-01', opdToken: null,
    departmentId: null, providerId: 2, appointmentId: null, admissionId: 9, doctorAssignmentId: null, checkedInByName: 'Front desk',
    checkedInAt: new Date('2099-03-01T04:00:00Z'), statusChangedAt: null, statusChangedByName: null, completedAt: new Date('2099-03-04T06:30:00Z'),
    cancelReason: 'never exported', providerName: 'Dr. Rao',
    diagnosisRanks: [{ diagnosisId: 11, rank: 1 }, { diagnosisId: 12, rank: 2 }],
    ...o,
  }
}

const ACT = 'http://terminology.hl7.org/CodeSystem/v3-ActCode'

describe('encounterToFhir', () => {
  it('maps an IPD encounter to IMP/finished with ranked diagnoses', () => {
    const e = encounterToFhir(enc())
    expect(e).toEqual({
      resourceType: 'Encounter',
      id: 'encounter-5',
      status: 'finished',
      class: { system: ACT, code: 'IMP' },
      subject: { reference: 'Patient/RD-1' },
      period: { start: '2099-03-01T04:00:00.000Z', end: '2099-03-04T06:30:00.000Z' },
      participant: [{ individual: { display: 'Dr. Rao' } }],
      diagnosis: [{ condition: { reference: 'Condition/condition-11' }, rank: 1 }, { condition: { reference: 'Condition/condition-12' }, rank: 2 }],
    })
    expect(JSON.stringify(e)).not.toContain('never exported')
  })

  it('maps OPD statuses to AMB and omits an open end and an empty diagnosis list', () => {
    const map = { checked_in: 'arrived', in_consultation: 'in-progress', completed: 'finished', cancelled: 'cancelled' } as const
    for (const [status, fhir] of Object.entries(map)) {
      const e = encounterToFhir(enc({ encounterType: 'opd', status: status as keyof typeof map, completedAt: null, diagnosisRanks: [] }))
      expect(e.status).toBe(fhir)
      expect(e.class.code).toBe('AMB')
      expect(e.period).toEqual({ start: '2099-03-01T04:00:00.000Z' })
      expect(e).not.toHaveProperty('diagnosis')
    }
    expect(encountersToFhir([enc(), enc({ id: 6 })]).map((e) => e.id)).toEqual(['encounter-5', 'encounter-6'])
  })
})
