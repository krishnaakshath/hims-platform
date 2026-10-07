import { and, eq, inArray } from 'drizzle-orm'
import { liveDiagnosis } from '@/lib/queries/diagnoses' // SP6
import { getDb } from '@/db/client'
import { patients, allergies, diagnoses, medicationEpisodes, medications } from '@/db/schema'
// SP6
import { asc, getTableColumns, isNull } from 'drizzle-orm'
import { codeSystems, codes, encounterProcedures, encounters, providers, type DiagnosisRow, type EncounterProcedureRow, type EncounterRow } from '@/db/schema'
import type { CodeBinding } from '@/lib/coding/code-systems'
import { findLoadedCodes } from '@/lib/queries/code-systems'
// end SP6
import { listDispensesForPatient } from '@/lib/queries/medication-dispenses'
import { listOrdersForPatient, type PatientLabOrderRow } from '@/lib/queries/lab-orders'
import type { DispenseWithMedicationName } from '@/lib/fhir/medication-dispense'
import { publicPatientColumns, type PublicPatientRow } from '@/lib/queries/patient-columns'

// SP6: coded rows carry the code system they were coded from (`binding`, built only from the
// joined code_systems row's kind/version/isSample), which decides whether FHIR may name a system.
export type DiagnosisFhirRow = DiagnosisRow & { binding: CodeBinding | null }
export type ProcedureFhirRow = EncounterProcedureRow & { binding: CodeBinding | null; performedByName: string | null }
export type EncounterFhirRow = EncounterRow & { providerName: string; diagnosisRanks: { diagnosisId: number; rank: number }[] }

export interface PatientFhirData {
  patient: PublicPatientRow
  allergyRows: (typeof allergies.$inferSelect)[]
  diagnosisRows: DiagnosisFhirRow[] // SP6: live rows only, with their binding
  medicationEpisodeRows: (typeof medicationEpisodes.$inferSelect)[]
  dispenseRows: DispenseWithMedicationName[]
  labOrderRows: PatientLabOrderRow[]
  // SP6
  procedureRows: ProcedureFhirRow[]
  encounterRows: EncounterFhirRow[]
  /** Lab test codes found in the current, loaded, non-sample LOINC version, keyed by code. */
  loincBindings: Map<string, CodeBinding>
  // end SP6
}

// SP6: the joined code system (left join through code_id) as a binding, or null when uncoded.
const bindingColumns = { bindingKind: codeSystems.kind, bindingVersion: codeSystems.version, bindingIsSample: codeSystems.isSample }
function toBinding<T extends { bindingKind: CodeBinding['kind'] | null; bindingVersion: string | null; bindingIsSample: boolean | null }>(
  r: T,
): Omit<T, keyof typeof bindingColumns> & { binding: CodeBinding | null } {
  const { bindingKind, bindingVersion, bindingIsSample, ...rest } = r
  return { ...rest, binding: bindingKind && bindingVersion !== null ? { kind: bindingKind, version: bindingVersion, isSample: bindingIsSample ?? false } : null }
}

// One round of already-patient-scoped reads, exercised end-to-end by the
// FHIR export routes -- not a cached read like getPatientDetail (this reads
// only what export needs, not the full wide patient-detail object, so it
// doesn't share -- or invalidate -- that cache).
export async function gatherPatientFhirData(anonId: string): Promise<PatientFhirData | null> {
  const db = getDb()
  const [patient] = await db.select(publicPatientColumns).from(patients).where(eq(patients.id, anonId))
  if (!patient) return null

  const [allergyRows, diagnosisJoined, medicationEpisodeRows, dispenses, labOrderRows, procedureJoined, encounterJoined] = await Promise.all([
    db.select().from(allergies).where(eq(allergies.patientId, anonId)),
    // SP6: voided rows hidden; coded rows joined to the code system they were coded from.
    db.select({ ...getTableColumns(diagnoses), ...bindingColumns }).from(diagnoses)
      .leftJoin(codes, eq(codes.id, diagnoses.codeId))
      .leftJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
      .where(and(eq(diagnoses.patientId, anonId), liveDiagnosis))
      .orderBy(asc(diagnoses.id)),
    db.select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, anonId)),
    listDispensesForPatient(anonId),
    listOrdersForPatient(anonId),
    // SP6: live procedures with their performer's name and code system.
    db.select({ ...getTableColumns(encounterProcedures), performedByName: providers.name, ...bindingColumns }).from(encounterProcedures)
      .leftJoin(providers, eq(providers.id, encounterProcedures.performedByProviderId))
      .leftJoin(codes, eq(codes.id, encounterProcedures.codeId))
      .leftJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
      .where(and(eq(encounterProcedures.patientId, anonId), isNull(encounterProcedures.voidedAt)))
      .orderBy(asc(encounterProcedures.performedOn), asc(encounterProcedures.id)),
    // SP6: the patient's encounters with their doctor's name.
    db.select({ ...getTableColumns(encounters), providerName: providers.name }).from(encounters)
      .innerJoin(providers, eq(providers.id, encounters.providerId))
      .where(eq(encounters.patientId, anonId))
      .orderBy(asc(encounters.checkedInAt), asc(encounters.id)),
  ])
  // SP6
  const diagnosisRows: DiagnosisFhirRow[] = diagnosisJoined.map(toBinding)
  const procedureRows: ProcedureFhirRow[] = procedureJoined.map((r) => ({ ...toBinding(r), performedByName: r.performedByName ?? null }))
  // Rank per encounter: primary first, then sequence (unsequenced last), then id.
  const typeOrder = (t: DiagnosisRow['diagnosisType']) => (t === 'primary' ? 0 : 1)
  const ranked = [...diagnosisRows]
    .filter((d) => d.encounterId !== null)
    .sort((a, b) => typeOrder(a.diagnosisType) - typeOrder(b.diagnosisType)
      || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)
      || a.id - b.id)
  const ranksByEncounter = new Map<number, { diagnosisId: number; rank: number }[]>()
  for (const d of ranked) {
    const list = ranksByEncounter.get(d.encounterId!) ?? []
    list.push({ diagnosisId: d.id, rank: list.length + 1 })
    ranksByEncounter.set(d.encounterId!, list)
  }
  const encounterRows: EncounterFhirRow[] = encounterJoined.map((e) => ({ ...e, diagnosisRanks: ranksByEncounter.get(e.id) ?? [] }))
  const loincBindings = await findLoadedCodes('loinc', labOrderRows.map((o) => o.testCode))
  // end SP6

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

  return { patient, allergyRows, diagnosisRows, medicationEpisodeRows, dispenseRows, labOrderRows, procedureRows, encounterRows, loincBindings }
}
