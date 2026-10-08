// Code-system kinds, patterns and pure helpers (SP6). Client-safe: no node:/DB imports.

export const CODE_SYSTEM_KINDS = ['icd10', 'icd10pcs', 'snomed', 'loinc', 'hbp'] as const
export type CodeSystemKind = (typeof CODE_SYSTEM_KINDS)[number]

export const CODE_SYSTEM_LABEL: Record<CodeSystemKind, string> = {
  icd10: 'ICD-10',
  icd10pcs: 'ICD-10-PCS',
  snomed: 'SNOMED CT',
  loinc: 'LOINC',
  hbp: 'PM-JAY HBP package',
}

export const CODE_PATTERN: Record<CodeSystemKind, RegExp> = {
  icd10: /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/,
  icd10pcs: /^[0-9A-HJ-NP-Z]{7}$/,
  snomed: /^[1-9][0-9]{5,17}$/,
  loinc: /^[1-9][0-9]{0,6}-[0-9]$/,
  hbp: /^[A-Z]{1,4}[0-9]{1,4}[A-Z0-9]{0,4}$/,
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase()
}

export const CODE_SYSTEM_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

export function isSampleVersion(version: string): boolean {
  return version.startsWith('SAMPLE-')
}

export const FHIR_SYSTEM_URI: Record<CodeSystemKind, string | null> = {
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  icd10pcs: 'http://www.cms.gov/Medicare/Coding/ICD10',
  snomed: 'http://snomed.info/sct',
  loinc: 'http://loinc.org',
  hbp: null,
}

export interface CodeBinding { kind: CodeSystemKind; version: string; isSample: boolean }

/** FHIR system URI for a code, or null for sample sets and kinds without a confirmed URI. */
export function fhirSystemFor(b: CodeBinding): string | null {
  return b.isSample ? null : FHIR_SYSTEM_URI[b.kind]
}

export const DIAGNOSIS_CODE_KINDS = ['icd10', 'snomed'] as const
export const PROCEDURE_CODE_KINDS = ['icd10pcs', 'snomed', 'hbp'] as const

/** Inclusive range check on ISO dates (string comparison). */
export function isCodeValidOn(
  c: { active: boolean; effectiveFrom: string | null; effectiveTo: string | null },
  dateIso: string,
): boolean {
  if (!c.active) return false
  if (c.effectiveFrom !== null && dateIso < c.effectiveFrom) return false
  if (c.effectiveTo !== null && dateIso > c.effectiveTo) return false
  return true
}

function stripCode(s: string): string {
  return s.replace(/\./g, '').toUpperCase()
}

/** True when `code` starts with the exclusion `entry` (dots ignored), so `E10` excludes `E10.9`. */
export function codeMatchesExclusion(code: string, entry: string): boolean {
  const e = stripCode(entry)
  return e.length > 0 && stripCode(code).startsWith(e)
}
