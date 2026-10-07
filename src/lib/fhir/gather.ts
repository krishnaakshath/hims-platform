import { and, eq, inArray } from 'drizzle-orm'
import { liveDiagnosis } from '@/lib/queries/diagnoses' // SP6
import { getDb } from '@/db/client'
import { patients, allergies, diagnoses, medicationEpisodes, medications } from '@/db/schema'
import { listDispensesForPatient } from '@/lib/queries/medication-dispenses'
import { listOrdersForPatient, type PatientLabOrderRow } from '@/lib/queries/lab-orders'
import type { DispenseWithMedicationName } from '@/lib/fhir/medication-dispense'
import { publicPatientColumns, type PublicPatientRow } from '@/lib/queries/patient-columns'

export interface PatientFhirData {
  patient: PublicPatientRow
  allergyRows: (typeof allergies.$inferSelect)[]
  diagnosisRows: (typeof diagnoses.$inferSelect)[]
  medicationEpisodeRows: (typeof medicationEpisodes.$inferSelect)[]
  dispenseRows: DispenseWithMedicationName[]
  labOrderRows: PatientLabOrderRow[]
}

// One round of already-patient-scoped reads, exercised end-to-end by the
// FHIR export routes -- not a cached read like getPatientDetail (this reads
// only what export needs, not the full wide patient-detail object, so it
// doesn't share -- or invalidate -- that cache).
export async function gatherPatientFhirData(anonId: string): Promise<PatientFhirData | null> {
  const db = getDb()
  const [patient] = await db.select(publicPatientColumns).from(patients).where(eq(patients.id, anonId))
  if (!patient) return null

  const [allergyRows, diagnosisRows, medicationEpisodeRows, dispenses, labOrderRows] = await Promise.all([
    db.select().from(allergies).where(eq(allergies.patientId, anonId)),
    db.select().from(diagnoses).where(and(eq(diagnoses.patientId, anonId), liveDiagnosis)), // SP6: voided rows hidden
    db.select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, anonId)),
    listDispensesForPatient(anonId),
    listOrdersForPatient(anonId),
  ])

  // Map lookup instead of an N+1 query per dispense.
  const medicationIds = [...new Set(dispenses.map((d) => d.medicationId))]
  const medicationNameById = new Map(
    medicationIds.length > 0
      ? (await db.select({ id: medications.id, name: medications.name }).from(medications).where(inArray(medications.id, medicationIds))).map((m) => [m.id, m.name] as const)
      : []
  )
  const dispenseRows: DispenseWithMedicationName[] = dispenses.map((dispense) => ({
    dispense,
    medicationName: medicationNameById.get(dispense.medicationId) ?? 'Unknown medication',
  }))

  return { patient, allergyRows, diagnosisRows, medicationEpisodeRows, dispenseRows, labOrderRows }
}
