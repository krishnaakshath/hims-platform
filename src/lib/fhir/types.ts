// Shared FHIR R4 type fragments used across this module's resource mapping
// functions. Not exhaustive FHIR R4 -- just the shapes the six resources in
// this plan actually need.

export interface FhirReference { reference: string }
export interface FhirCoding { system?: string; code: string; display?: string }
export interface FhirCodeableConcept { text?: string; coding?: FhirCoding[] }
