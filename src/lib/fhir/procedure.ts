// FHIR Procedure (SP6 Task 15): a live encounter procedure. The coding follows ruling 11 via
// `codingFor` (system + version only from a loaded non-sample code system; never for HBP).
import type { ProcedureFhirRow } from './gather'
import type { FhirCodeableConcept, FhirReference } from './types'
import { codedConcept, codingFor } from './condition'

export interface FhirProcedure {
  resourceType: 'Procedure'
  id: string
  status: 'completed'
  subject: FhirReference
  encounter: FhirReference
  code: FhirCodeableConcept
  performedDateTime: string
  performer?: { actor: { display: string } }[]
}

export function procedureToFhir(row: ProcedureFhirRow): FhirProcedure {
  return {
    resourceType: 'Procedure',
    id: `procedure-${row.id}`,
    status: 'completed',
    subject: { reference: `Patient/${row.patientId}` },
    encounter: { reference: `Encounter/encounter-${row.encounterId}` },
    code: codedConcept(row.description, codingFor(row.code ?? '', row.codeDisplay, row.binding)),
    performedDateTime: row.performedOn,
    ...(row.performedByName ? { performer: [{ actor: { display: row.performedByName } }] } : {}),
  }
}

export function proceduresToFhir(rows: ProcedureFhirRow[]): FhirProcedure[] {
  return rows.map(procedureToFhir)
}
