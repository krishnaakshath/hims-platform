// Test fixture: a plain doctor assignment row. Production check-in goes through
// checkInVisit (one transaction with the OPD token); this only seeds rows for
// tests of the assignment queue, schedule and decline flows.
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'

export interface DoctorAssignmentFixtureInput {
  patientId: string
  providerId: number
  visitType: 'inpatient' | 'outpatient'
  urgency: 'routine' | 'urgent' | 'emergency'
  reason: string
  roomId: number | null
  assignedByName: string
}

export async function createDoctorAssignment(input: DoctorAssignmentFixtureInput): Promise<DoctorAssignmentRow> {
  const [created] = await getDb().insert(doctorAssignments).values(input).returning()
  return created
}
