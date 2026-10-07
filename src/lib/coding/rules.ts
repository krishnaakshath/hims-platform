// Pure coding checks (SP6). Dates are ISO strings compared lexically; no Date local getters.
import { ageOnDate } from '@/lib/india-time'
import {
  DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS, codeMatchesExclusion, isCodeValidOn, type CodeSystemKind,
} from '@/lib/coding/code-systems'
import type { CodeEntryStatus, DiagnosisType } from '@/lib/coding/status'

export type Gender = 'male' | 'female' | 'transgender' | 'other' | 'unknown'

export interface RuleCode {
  id: number
  kind: CodeSystemKind
  code: string
  active: boolean
  effectiveFrom: string | null
  effectiveTo: string | null
  selectable: boolean
  sexRestriction: 'male' | 'female' | null
  ageMinYears: number | null
  ageMaxYears: number | null
  excludes: string[]
}

export interface RuleDiagnosis { id: number; type: DiagnosisType | null; codingStatus: CodeEntryStatus; code: RuleCode | null }
export interface RuleProcedure {
  id: number
  codingStatus: CodeEntryStatus
  performedOn: string
  code: RuleCode | null
  serviceMappedCodes: { kind: CodeSystemKind; code: string }[] | null
}
export interface CodingRuleInput {
  encounterDate: string
  encounterEndDate: string | null
  patient: { gender: Gender | null; dob: string }
  diagnoses: RuleDiagnosis[]
  procedures: RuleProcedure[]
}
export type CodingStage = 'coded' | 'finalise'

export const CODING_ISSUE_CODES = [
  'no_diagnoses', 'not_coded', 'code_inactive', 'code_not_valid_on_date', 'code_not_selectable', 'code_system_not_allowed',
  'sex_mismatch', 'sex_unverifiable', 'age_out_of_range', 'excludes_conflict', 'duplicate_code', 'primary_missing',
  'multiple_primary', 'provisional_remaining', 'procedure_date_outside_encounter', 'procedure_not_mapped_to_service',
] as const
export type CodingIssueCode = (typeof CODING_ISSUE_CODES)[number]

export interface CodingIssue {
  severity: 'error' | 'warning'
  code: CodingIssueCode
  entry: { kind: 'diagnosis' | 'procedure'; id: number } | null
  message: string
}

type EntryKind = 'diagnosis' | 'procedure'

export function checkCodeForEntry(
  code: RuleCode,
  entryKind: EntryKind,
  ctx: { onDate: string; gender: Gender | null; dob: string },
  entryId?: number,
): CodingIssue[] {
  const entry = entryId === undefined ? null : { kind: entryKind, id: entryId }
  const out: CodingIssue[] = []
  const push = (severity: 'error' | 'warning', c: CodingIssueCode, message: string) => out.push({ severity, code: c, entry, message })

  const allowed: readonly CodeSystemKind[] = entryKind === 'diagnosis' ? DIAGNOSIS_CODE_KINDS : PROCEDURE_CODE_KINDS
  if (!allowed.includes(code.kind)) push('error', 'code_system_not_allowed', `Code ${code.code} is from a code system that cannot be used for a ${entryKind}`)
  if (!code.active) push('error', 'code_inactive', `Code ${code.code} is not active`)
  else if (!isCodeValidOn(code, ctx.onDate)) push('error', 'code_not_valid_on_date', `Code ${code.code} is not valid on the date of service`)
  if (!code.selectable) push('error', 'code_not_selectable', `Code ${code.code} is a heading and cannot be selected`)
  if (code.sexRestriction !== null) {
    if (ctx.gender === 'male' || ctx.gender === 'female') {
      if (ctx.gender !== code.sexRestriction) push('error', 'sex_mismatch', `Code ${code.code} does not match the patient's recorded sex`)
    } else {
      push('warning', 'sex_unverifiable', `Code ${code.code} is sex-specific and the patient's sex cannot confirm it`)
    }
  }
  if (code.ageMinYears !== null || code.ageMaxYears !== null) {
    const age = ageOnDate(ctx.dob, ctx.onDate)
    if ((code.ageMinYears !== null && age < code.ageMinYears) || (code.ageMaxYears !== null && age > code.ageMaxYears)) {
      push('error', 'age_out_of_range', `Code ${code.code} does not fit the patient's age on the date of service`)
    }
  }
  return out
}

export function hasBlockingIssues(issues: CodingIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

export function validateEncounterCoding(input: CodingRuleInput, stage: CodingStage): CodingIssue[] {
  const issues: CodingIssue[] = []
  const gateSeverity = stage === 'finalise' ? 'error' : 'warning'
  const { gender, dob } = input.patient

  if (input.diagnoses.length === 0) {
    issues.push({ severity: 'error', code: 'no_diagnoses', entry: null, message: 'The visit has no diagnoses' })
  }

  const run = (kind: EntryKind, id: number, status: CodeEntryStatus, code: RuleCode | null, onDate: string) => {
    if (status !== 'coded' || code === null) {
      issues.push({ severity: 'error', code: 'not_coded', entry: { kind, id }, message: `A ${kind} on this visit has not been coded yet` })
    }
    if (code !== null && status !== 'uncoded') issues.push(...checkCodeForEntry(code, kind, { onDate, gender, dob }, id))
  }

  for (const d of input.diagnoses) run('diagnosis', d.id, d.codingStatus, d.code, input.encounterDate)

  const coded = input.diagnoses.filter((d): d is RuleDiagnosis & { code: RuleCode } => d.code !== null)
  const seen = new Set<string>()
  for (const d of coded) {
    const key = `${d.code.kind}:${d.code.code}`
    if (seen.has(key)) issues.push({ severity: 'error', code: 'duplicate_code', entry: { kind: 'diagnosis', id: d.id }, message: `Code ${d.code.code} is listed more than once` })
    seen.add(key)
  }
  const pairs = new Set<string>()
  coded.forEach((a, i) => coded.forEach((b, j) => {
    if (i === j || a.code.kind !== b.code.kind) return
    if (!a.code.excludes.some((e) => codeMatchesExclusion(b.code.code, e))) return
    const pair = [a.id, b.id].sort((x, y) => x - y).join(':')
    if (pairs.has(pair)) return
    pairs.add(pair)
    issues.push({ severity: 'error', code: 'excludes_conflict', entry: { kind: 'diagnosis', id: a.id }, message: `Code ${a.code.code} excludes code ${b.code.code}` })
  }))

  const primaries = input.diagnoses.filter((d) => d.type === 'primary')
  if (primaries.length > 1) issues.push({ severity: 'error', code: 'multiple_primary', entry: null, message: 'More than one primary diagnosis is set' })
  if (primaries.length === 0 && input.diagnoses.length > 0) {
    issues.push({ severity: gateSeverity, code: 'primary_missing', entry: null, message: 'No primary diagnosis is set' })
  }
  for (const d of input.diagnoses) {
    if (d.type === 'provisional') {
      issues.push({ severity: gateSeverity, code: 'provisional_remaining', entry: { kind: 'diagnosis', id: d.id }, message: d.code ? `Code ${d.code.code} is still a provisional diagnosis` : 'A provisional diagnosis remains' })
    }
  }

  const end = input.encounterEndDate ?? input.encounterDate
  const procSeen = new Set<string>()
  for (const p of input.procedures) {
    run('procedure', p.id, p.codingStatus, p.code, p.performedOn)
    if (p.performedOn < input.encounterDate || p.performedOn > end) {
      issues.push({ severity: 'warning', code: 'procedure_date_outside_encounter', entry: { kind: 'procedure', id: p.id }, message: p.code ? `Procedure ${p.code.code} is dated outside the visit` : 'A procedure is dated outside the visit' })
    }
    if (p.code) {
      const key = `${p.code.kind}:${p.code.code}`
      if (procSeen.has(key)) issues.push({ severity: 'warning', code: 'duplicate_code', entry: { kind: 'procedure', id: p.id }, message: `Procedure ${p.code.code} is listed more than once` })
      procSeen.add(key)
      const mapped = p.serviceMappedCodes
      if (mapped !== null && mapped.length > 0 && !mapped.some((m) => m.kind === p.code!.kind && m.code === p.code!.code)) {
        issues.push({ severity: 'warning', code: 'procedure_not_mapped_to_service', entry: { kind: 'procedure', id: p.id }, message: `Procedure ${p.code.code} is not one of the codes mapped to the billed service` })
      }
    }
  }
  return issues
}
