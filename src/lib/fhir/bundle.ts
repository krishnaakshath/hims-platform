import type { PatientFhirData } from '@/lib/fhir/gather'
import { patientToFhir } from '@/lib/fhir/patient'
import { allergiesToFhir } from '@/lib/fhir/allergy'
import { conditionsToFhir } from '@/lib/fhir/condition'
import { medicationEpisodesToFhir } from '@/lib/fhir/medication-request'
import { medicationDispensesToFhir } from '@/lib/fhir/medication-dispense'
import { observationsToFhir } from '@/lib/fhir/observation'

export interface FhirBundleEntry<T> { resource: T }
export interface FhirBundle<T> { resourceType: 'Bundle'; type: 'collection'; total: number; entry: FhirBundleEntry<T>[] }

export function buildBundle<T>(resources: T[]): FhirBundle<T> {
  return { resourceType: 'Bundle', type: 'collection', total: resources.length, entry: resources.map((resource) => ({ resource })) }
}

// The `Patient` resource itself is always present -- an otherwise data-free
// patient still produces a Bundle with `total: 1`, not an empty one.
export function buildFullBundle(data: PatientFhirData): FhirBundle<unknown> {
  return buildBundle<unknown>([
    patientToFhir(data.patient),
    ...allergiesToFhir(data.allergyRows),
    ...conditionsToFhir(data.diagnosisRows),
    ...medicationEpisodesToFhir(data.medicationEpisodeRows),
    ...medicationDispensesToFhir(data.dispenseRows),
    ...observationsToFhir(data.patient.id, data.labOrderRows),
  ])
}
