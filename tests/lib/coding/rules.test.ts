import { describe, it, expect } from 'vitest'
import { validateEncounterCoding, checkCodeForEntry, hasBlockingIssues, type RuleCode } from '@/lib/coding/rules'

function code(over: Partial<RuleCode> = {}): RuleCode {
  return { id: 1, kind: 'icd10', code: 'E11.9', active: true, effectiveFrom: null, effectiveTo: null, selectable: true, sexRestriction: null, ageMinYears: null, ageMaxYears: null, excludes: [], ...over }
}
const base = { encounterDate: '2026-10-07', encounterEndDate: '2026-10-09', patient: { gender: 'male' as const, dob: '1990-05-01' }, procedures: [] }
const ctx = { onDate: '2026-10-07', gender: 'male' as const, dob: '1990-05-01' }

describe('coding rules', () => {
  it('primary missing warns at coded and blocks finalise', () => {
    const input = { ...base, diagnoses: [{ id: 1, type: 'secondary' as const, codingStatus: 'coded' as const, code: code() }] }
    expect(validateEncounterCoding(input, 'coded')).toEqual([expect.objectContaining({ code: 'primary_missing', severity: 'warning' })])
    expect(hasBlockingIssues(validateEncounterCoding(input, 'coded'))).toBe(false)
    expect(hasBlockingIssues(validateEncounterCoding(input, 'finalise'))).toBe(true)
  })
  it('flags sex and age edits from the code table', () => {
    expect(checkCodeForEntry(code({ sexRestriction: 'female' }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '1990-05-01' }).map((i) => i.code)).toEqual(['sex_mismatch'])
    expect(checkCodeForEntry(code({ sexRestriction: 'female' }), 'diagnosis', { onDate: '2026-10-07', gender: 'unknown', dob: '1990-05-01' })[0].severity).toBe('warning')
    expect(checkCodeForEntry(code({ sexRestriction: 'female' }), 'diagnosis', { onDate: '2026-10-07', gender: null, dob: '1990-05-01' })[0].code).toBe('sex_unverifiable')
    expect(checkCodeForEntry(code({ sexRestriction: 'female' }), 'diagnosis', { onDate: '2026-10-07', gender: 'female', dob: '1990-05-01' })).toEqual([])
    expect(checkCodeForEntry(code({ ageMaxYears: 17 }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '2008-10-07' }).map((i) => i.code)).toEqual(['age_out_of_range'])
    expect(checkCodeForEntry(code({ ageMaxYears: 17 }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '2008-10-08' })).toEqual([])
    expect(checkCodeForEntry(code({ ageMinYears: 18 }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '2008-10-08' }).map((i) => i.code)).toEqual(['age_out_of_range'])
  })
  it('rejects a PCS code as a diagnosis, inactive and out-of-date codes, header codes', () => {
    expect(checkCodeForEntry(code({ kind: 'icd10pcs' }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_system_not_allowed')
    expect(checkCodeForEntry(code({ kind: 'icd10' }), 'procedure', ctx).map((i) => i.code)).toContain('code_system_not_allowed')
    expect(checkCodeForEntry(code({ kind: 'hbp' }), 'procedure', ctx)).toEqual([])
    expect(checkCodeForEntry(code({ active: false }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_inactive')
    expect(checkCodeForEntry(code({ effectiveTo: '2026-10-06' }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_not_valid_on_date')
    expect(checkCodeForEntry(code({ selectable: false }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_not_selectable')
    const issue = checkCodeForEntry(code({ selectable: false }), 'diagnosis', ctx, 7)[0]
    expect(issue).toMatchObject({ severity: 'error', entry: { kind: 'diagnosis', id: 7 } }); expect(issue.message).toContain('E11.9')
  })
  it('finds excludes conflicts and duplicates once', () => {
    const dx = [{ id: 1, type: 'primary' as const, codingStatus: 'coded' as const, code: code({ code: 'U8Z.0', excludes: ['U8Z.1'] }) },
      { id: 2, type: 'secondary' as const, codingStatus: 'coded' as const, code: code({ id: 2, code: 'U8Z.1' }) }, { id: 3, type: 'secondary' as const, codingStatus: 'coded' as const, code: code({ id: 2, code: 'U8Z.1' }) }]
    const codes = validateEncounterCoding({ ...base, diagnoses: dx }, 'coded').map((i) => i.code)
    expect(codes.filter((c) => c === 'excludes_conflict')).toHaveLength(2)
    expect(codes.filter((c) => c === 'duplicate_code')).toHaveLength(1)
  })
  it('mutual excludes are reported once per pair', () => {
    const dx = [{ id: 1, type: 'primary' as const, codingStatus: 'coded' as const, code: code({ code: 'A00', excludes: ['B00'] }) },
      { id: 2, type: 'secondary' as const, codingStatus: 'coded' as const, code: code({ id: 2, code: 'B00', excludes: ['A00'] }) }]
    expect(validateEncounterCoding({ ...base, diagnoses: dx }, 'coded').filter((i) => i.code === 'excludes_conflict')).toHaveLength(1)
  })
  it('uncoded and proposed rows block both stages; an encounter with no diagnoses blocks', () => {
    expect(validateEncounterCoding({ ...base, diagnoses: [] }, 'coded').map((i) => i.code)).toContain('no_diagnoses')
    expect(validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'proposed', code: code() }] }, 'coded').map((i) => i.code)).toContain('not_coded')
    const un = validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'uncoded', code: null }] }, 'finalise')
    expect(un).toEqual([expect.objectContaining({ code: 'not_coded', severity: 'error', entry: { kind: 'diagnosis', id: 1 } })])
  })
  it('multiple primaries are an error; provisional is warning at coded and error at finalise', () => {
    const dx = [{ id: 1, type: 'primary' as const, codingStatus: 'coded' as const, code: code() }, { id: 2, type: 'primary' as const, codingStatus: 'coded' as const, code: code({ id: 2, code: 'E12' }) },
      { id: 3, type: 'provisional' as const, codingStatus: 'coded' as const, code: code({ id: 3, code: 'E13' }) }]
    const at = (s: 'coded' | 'finalise') => validateEncounterCoding({ ...base, diagnoses: dx }, s)
    expect(at('coded').find((i) => i.code === 'multiple_primary')?.severity).toBe('error')
    expect(at('coded').find((i) => i.code === 'provisional_remaining')?.severity).toBe('warning')
    expect(at('finalise').find((i) => i.code === 'provisional_remaining')?.severity).toBe('error')
  })
  it('warns on a procedure dated outside the stay and not in the service map', () => {
    const p = { id: 9, codingStatus: 'coded' as const, performedOn: '2026-10-10', code: code({ kind: 'icd10pcs', code: 'ZZ00000' }), serviceMappedCodes: [{ kind: 'icd10pcs' as const, code: 'ZZ00001' }] }
    const issues = validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'coded', code: code() }], procedures: [p] }, 'finalise')
    expect(issues.map((i) => [i.code, i.severity])).toEqual(expect.arrayContaining([['procedure_date_outside_encounter', 'warning'], ['procedure_not_mapped_to_service', 'warning']]))
    expect(hasBlockingIssues(issues)).toBe(false)
    const ok = validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'coded', code: code() }], procedures: [{ ...p, performedOn: '2026-10-09', serviceMappedCodes: [{ kind: 'icd10pcs', code: 'ZZ00000' }] }] }, 'finalise')
    expect(ok).toEqual([])
  })
  it('single-day encounter uses the encounter date as the end; duplicate procedures warn', () => {
    const p = (id: number) => ({ id, codingStatus: 'coded' as const, performedOn: '2026-10-08', code: code({ kind: 'icd10pcs', code: 'ZZ00000' }), serviceMappedCodes: null })
    const issues = validateEncounterCoding({ ...base, encounterEndDate: null, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'coded', code: code() }], procedures: [p(1), p(2)] }, 'coded')
    expect(issues.map((i) => i.code).sort()).toEqual(['duplicate_code', 'procedure_date_outside_encounter', 'procedure_date_outside_encounter'])
    expect(issues.find((i) => i.code === 'duplicate_code')?.severity).toBe('warning')
  })
  it('runs code checks on every coded entry on the right date', () => {
    const issues = validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'coded', code: code({ active: false }) }] }, 'coded')
    expect(issues).toEqual([expect.objectContaining({ code: 'code_inactive', entry: { kind: 'diagnosis', id: 1 } })])
  })
})
