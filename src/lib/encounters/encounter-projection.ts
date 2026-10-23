import type { EncounterRow } from '@/db/schema'

// The encounter fields a status-changing route answers with (SP3 M7): an explicit projection, so
// no free text (cancel reason) and no internal links (assignment id, check-in clerk) ride along.
export function encounterResponse(e: EncounterRow) {
  return {
    id: e.id, patientId: e.patientId, encounterType: e.encounterType, visitType: e.visitType, status: e.status,
    encounterDate: e.encounterDate, opdToken: e.opdToken, departmentId: e.departmentId, providerId: e.providerId,
    appointmentId: e.appointmentId, admissionId: e.admissionId, checkedInAt: e.checkedInAt,
    statusChangedAt: e.statusChangedAt, statusChangedByName: e.statusChangedByName, completedAt: e.completedAt,
  }
}

/** WS1 T5 (spec ruling 4): the refusal both the complete and the status route answer. */
export const DIAGNOSIS_MISSING_BODY = { error: 'Add a diagnosis or give a reason before completing the visit.', code: 'diagnosis_missing' } as const

/** WS2 T14: a visit charge is on a finalised invoice (spec ruling 6, cancellation). */
export const visitBilledBody = (invoiceNumber: string) =>
  ({ error: `This visit is on invoice ${invoiceNumber}. Cancel that invoice first.`, code: 'visit_billed' }) as const

/** WS2 T14: a lab sample was collected or a procedure was coded (both count as performed). */
export const VISIT_HAS_PERFORMED_ORDERS_BODY = {
  error: 'Tests or procedures on this visit have already been performed; it cannot be cancelled.', code: 'visit_has_performed_orders',
} as const
