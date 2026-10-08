// FHIR Encounter (SP6 Task 15): one OPD/IPD/lab visit with its doctor and ranked diagnoses
// (rank 1 = primary, then by sequence and id). Free-text visit fields such as the cancel reason
// are never exported.
import type { EncounterStatus } from '@/lib/encounters/status'
import type { EncounterFhirRow } from './gather'
import type { FhirCoding, FhirReference } from './types'

export interface FhirEncounter {
  resourceType: 'Encounter'
  id: string
  status: 'arrived' | 'in-progress' | 'finished' | 'cancelled'
  class: FhirCoding & { system: string }
  subject: FhirReference
  period: { start: string; end?: string }
  participant: { individual: { display: string } }[]
  diagnosis?: { condition: FhirReference; rank: number }[]
}

const STATUS: Record<EncounterStatus, FhirEncounter['status']> = {
  checked_in: 'arrived',
  in_consultation: 'in-progress',
  completed: 'finished',
  cancelled: 'cancelled',
}

const ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode'

export function encounterToFhir(row: EncounterFhirRow): FhirEncounter {
  return {
    resourceType: 'Encounter',
    id: `encounter-${row.id}`,
    status: STATUS[row.status],
    class: { system: ACT_CODE, code: row.encounterType === 'ipd' ? 'IMP' : 'AMB' },
    subject: { reference: `Patient/${row.patientId}` },
    period: { start: row.checkedInAt.toISOString(), ...(row.completedAt ? { end: row.completedAt.toISOString() } : {}) },
    participant: [{ individual: { display: row.providerName } }],
    ...(row.diagnosisRanks.length
      ? { diagnosis: row.diagnosisRanks.map((d) => ({ condition: { reference: `Condition/condition-${d.diagnosisId}` }, rank: d.rank })) }
      : {}),
  }
}

export function encountersToFhir(rows: EncounterFhirRow[]): FhirEncounter[] {
  return rows.map(encounterToFhir)
}
