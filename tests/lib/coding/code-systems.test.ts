import { describe, it, expect } from 'vitest'
import { CODE_PATTERN, isSampleVersion, fhirSystemFor, isCodeValidOn, codeMatchesExclusion, normalizeCode, CODE_SYSTEM_VERSION_PATTERN } from '@/lib/coding/code-systems'

describe('code systems', () => {
  it.each([['icd10', 'E11.9', true], ['icd10', 'E1', false], ['icd10pcs', '0DTJ4ZZ', true], ['icd10pcs', '0DTI4ZZ', false], ['loinc', '2345-7', true], ['snomed', '22298006', true], ['hbp', 'SMP001A', true]] as const)(
    '%s pattern on %s is %s', (k, c, ok) => { expect(CODE_PATTERN[k].test(c)).toBe(ok) })
  it('SAMPLE- versions are flagged sample and never get a FHIR system', () => {
    expect(isSampleVersion('SAMPLE-ICD10-0')).toBe(true)
    expect(fhirSystemFor({ kind: 'icd10', version: 'SAMPLE-ICD10-0', isSample: true })).toBeNull()
    expect(fhirSystemFor({ kind: 'icd10', version: '2019', isSample: false })).toBe('http://hl7.org/fhir/sid/icd-10')
    expect(fhirSystemFor({ kind: 'hbp', version: '2022', isSample: false })).toBeNull()
  })
  it('validity is inclusive at both ends', () => {
    const c = { active: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }
    expect(isCodeValidOn(c, '2026-01-01')).toBe(true)
    expect(isCodeValidOn(c, '2026-12-31')).toBe(true)
    expect(isCodeValidOn(c, '2025-12-31')).toBe(false)
    expect(isCodeValidOn(c, '2027-01-01')).toBe(false)
    expect(isCodeValidOn({ ...c, active: false }, '2026-06-01')).toBe(false)
    expect(isCodeValidOn({ active: true, effectiveFrom: null, effectiveTo: null }, '2026-06-01')).toBe(true)
  })
  it('exclusion entries match by prefix ignoring dots', () => {
    expect(codeMatchesExclusion('E10.9', 'E10')).toBe(true)
    expect(codeMatchesExclusion('E11.9', 'E10')).toBe(false)
    expect(codeMatchesExclusion('e10.9', 'E1.0')).toBe(true)
  })
  it('normalises and checks versions', () => {
    expect(normalizeCode('  e11.9 ')).toBe('E11.9')
    expect(CODE_SYSTEM_VERSION_PATTERN.test('2019')).toBe(true)
    expect(CODE_SYSTEM_VERSION_PATTERN.test('-bad')).toBe(false)
  })
})
