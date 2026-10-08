import { formatAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import { ABHA_NUMBER_SYSTEM, uhidSystem } from '@/lib/fhir/identifier-systems'
import type { PayerRef, SnapshotHospital, SnapshotPatient, SnapshotPolicy } from '@/lib/rcm/snapshot'
import {
  ACT_CODE, CS_IDENTIFIER_TYPE, HFR_SYSTEM, ORG_TYPE, PROFILE, RELATIONSHIP_CODING, ROHINI_SYSTEM, SUBSCRIBER_RELATIONSHIP, V2_0203, localSystem,
} from './systems'
import { ref, type FhirResource } from './types'

// Base resources for NHCX bundles (S5 6.5.0). Pure. The Patient carries only
// the UHID and, when the snapshot has it, the ABHA number: no telecom, no
// address and never a national ID number (spec §3).

export const NHCX_BUILD_ERROR_COPY = {
  patient_uhid_missing: 'The patient has no UHID',
  hospital_ids_missing: 'Set the hospital HFR or ROHINI ID in RCM settings',
  practitioner_registration_missing: 'The treating doctor has no registration number',
  sample_codes: 'Sample code sets cannot be sent to an insurer; load the licensed code set and re-code',
  unmapped_procedure_codes: 'A procedure code has no NHCX code system (package codes); submit through the portal',
  no_items: 'The claim has no items',
  no_diagnosis: 'Add at least one coded diagnosis',
  payer_not_on_nhcx: 'This insurer or TPA has no NHCX participant code',
  attachments_too_large: 'The attached documents are too large for NHCX; submit through the portal',
} as const
export type NhcxBuildErrorCode = keyof typeof NHCX_BUILD_ERROR_COPY

export class NhcxBuildError extends Error {
  constructor(public code: NhcxBuildErrorCode) {
    super(NHCX_BUILD_ERROR_COPY[code])
    this.name = 'NhcxBuildError'
  }
}

const GENDER: Record<string, string> = { male: 'male', female: 'female', transgender: 'other', other: 'other', unknown: 'unknown' }

export function nhcxPatient(p: SnapshotPatient, id: string): FhirResource {
  if (!p.uhid) throw new NhcxBuildError('patient_uhid_missing')
  const identifier: unknown[] = [{ type: { coding: [{ system: V2_0203, code: 'MR', display: 'Medical record number' }] }, system: uhidSystem(), value: p.uhid }]
  if (p.abhaNumber) {
    identifier.push({
      type: { coding: [{ system: CS_IDENTIFIER_TYPE, code: 'ABHA', display: 'Ayushman Bharat Health Account (ABHA) ID' }] },
      system: ABHA_NUMBER_SYSTEM, value: formatAbhaNumber(normalizeAbhaNumber(p.abhaNumber)),
    })
  }
  const r: FhirResource = { resourceType: 'Patient', id, meta: { profile: [PROFILE.Patient] }, identifier, name: [{ text: p.name }] }
  if (p.gender && GENDER[p.gender]) r.gender = GENDER[p.gender]
  if (p.dob) r.birthDate = p.dob
  return r
}

export function nhcxHospital(h: SnapshotHospital, id: string): FhirResource {
  const identifier: unknown[] = []
  if (h.hfrId) identifier.push({ type: { coding: [{ system: V2_0203, code: 'PRN', display: 'Provider number' }] }, system: HFR_SYSTEM, value: h.hfrId })
  if (h.rohiniId) {
    identifier.push({ type: { coding: [{ system: CS_IDENTIFIER_TYPE, code: 'ROHINI', display: 'Registry of Hospitals in Network of Insurance (ROHINI) ID' }] }, system: ROHINI_SYSTEM, value: h.rohiniId })
  }
  if (identifier.length === 0) throw new NhcxBuildError('hospital_ids_missing')
  return {
    resourceType: 'Organization', id, meta: { profile: [PROFILE.Organization] }, identifier,
    type: [{ coding: [{ system: ORG_TYPE, code: 'prov', display: 'Healthcare Provider' }] }], name: h.legalName,
  }
}

export function nhcxPayer(p: PayerRef, id: string): FhirResource {
  const tpa = p.kind === 'tpa'
  return {
    resourceType: 'Organization', id, meta: { profile: [PROFILE.Organization] },
    identifier: [{ type: { coding: [{ system: CS_IDENTIFIER_TYPE, code: 'OIN', display: 'Other identifier' }] }, system: localSystem('payer-code'), value: String(p.payerId) }],
    type: [{ coding: [{ system: ORG_TYPE, code: tpa ? 'pay' : 'ins', display: tpa ? 'Payer' : 'Insurance Company' }] }],
    name: p.name,
  }
}

/** The NMC/SMC registration is not an HPR id, so no system is sent (ruling; UNVERIFIED U15). */
export function nhcxPractitioner(d: { name: string; registrationNumber: string | null }, id: string): FhirResource {
  if (!d.registrationNumber) throw new NhcxBuildError('practitioner_registration_missing')
  return {
    resourceType: 'Practitioner', id, meta: { profile: [PROFILE.Practitioner] },
    identifier: [{ type: { coding: [{ system: V2_0203, code: 'MD', display: 'Medical License number' }] }, value: d.registrationNumber }],
    name: [{ text: d.name }],
  }
}

export function nhcxLocation(h: SnapshotHospital, id: string, organizationId: string): FhirResource {
  return { resourceType: 'Location', id, status: 'active', name: h.legalName, managingOrganization: ref(organizationId) }
}

export function nhcxCoverage(policy: SnapshotPolicy, id: string, refs: { patientId: string; insurerId: string }): FhirResource {
  const r: FhirResource = {
    resourceType: 'Coverage', id, meta: { profile: [PROFILE.Coverage] },
    identifier: [{ system: localSystem('policy-number'), value: policy.policyNumber }],
    status: 'active',
    type: { coding: [{ system: ACT_CODE, code: 'HIP', display: 'health insurance plan policy' }] },
    subscriber: ref(refs.patientId), subscriberId: policy.memberId, beneficiary: ref(refs.patientId),
    relationship: { coding: [{ system: SUBSCRIBER_RELATIONSHIP, code: RELATIONSHIP_CODING[policy.relationship] }] },
    period: { start: policy.validFrom, end: policy.validTo },
    payor: [ref(refs.insurerId)],
  }
  return r
}
