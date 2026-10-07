import type { PublicPatientRow } from '@/lib/queries/patient-columns'
import { formatAbhaNumber } from '@/lib/india/abha'
import { stateName } from '@/lib/india/reference'
import { ABHA_ADDRESS_SYSTEM, ABHA_NUMBER_SYSTEM, uhidSystem } from '@/lib/fhir/identifier-systems'

export interface FhirIdentifier { system?: string; type?: { text: string }; value: string }
export interface FhirAddress { line: string[]; city?: string; district?: string; state?: string; postalCode?: string; country: string }

export interface FhirPatient {
  resourceType: 'Patient'
  id: string
  identifier: FhirIdentifier[]
  name: { text: string }[]
  birthDate: string
  gender?: 'male' | 'female' | 'other' | 'unknown'
  address?: FhirAddress[]
}

const GENDER: Record<NonNullable<PublicPatientRow['gender']>, NonNullable<FhirPatient['gender']>> = {
  male: 'male', female: 'female', transgender: 'other', other: 'other', unknown: 'unknown',
}

// Built from named columns only (no spread of `patient`), so nothing else on
// the row can reach the output.
export function patientToFhir(patient: PublicPatientRow): FhirPatient {
  const identifier: FhirIdentifier[] = [{ value: patient.id }]
  if (patient.uhid) identifier.push({ system: uhidSystem(), type: { text: 'UHID' }, value: patient.uhid })
  if (patient.abhaNumber) identifier.push({ system: ABHA_NUMBER_SYSTEM, type: { text: 'ABHA Number' }, value: formatAbhaNumber(patient.abhaNumber) })
  if (patient.abhaAddress) identifier.push({ system: ABHA_ADDRESS_SYSTEM, type: { text: 'ABHA Address' }, value: patient.abhaAddress })

  const fhir: FhirPatient = {
    resourceType: 'Patient',
    id: patient.id,
    identifier,
    name: [{ text: patient.name }],
    birthDate: patient.dob,
  }
  if (patient.gender) fhir.gender = GENDER[patient.gender]
  if (patient.addressLine1) {
    const address: FhirAddress = {
      line: [patient.addressLine1, ...(patient.addressLine2 ? [patient.addressLine2] : [])],
      country: !patient.nationality || patient.nationality === 'IN' ? 'IN' : patient.nationality,
    }
    if (patient.city) address.city = patient.city
    if (patient.district) address.district = patient.district
    const state = patient.stateCode ? stateName(patient.stateCode) : null
    if (state) address.state = state
    if (patient.pinCode) address.postalCode = patient.pinCode
    fhir.address = [address]
  }
  return fhir
}
