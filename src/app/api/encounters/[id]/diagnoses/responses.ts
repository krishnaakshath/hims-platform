// WS1 T4: shared error mapping for the workspace diagnosis routes.
import { NextResponse } from 'next/server'
import type { DiagnosisError } from '@/lib/encounters/diagnosis-validation'
import type { CodingIssue } from '@/lib/coding/rules'
import { EncounterClosedError } from '@/lib/queries/encounter-clinical'
import { pgErrorCode } from '@/lib/db-errors'

const ERRORS: Record<DiagnosisError, { status: number; error: string }> = {
  code_not_current: { status: 422, error: 'That code is not in the current WHO ICD-10 version. Search again and pick a current code.' },
  coding_locked: { status: 409, error: 'This visit has been coded. Raise a coding query to change its diagnoses.' },
  primary_exists: { status: 409, error: 'This visit already has a primary diagnosis.' },
  not_found: { status: 404, error: 'Diagnosis not found' },
  code_not_valid_for_patient: { status: 422, error: 'That code does not fit this patient (sex or age). Choose another code.' },
}

// `issues` are SP6's rule results (code value and rule only, never patient data).
export function diagnosisErrorResponse(error: DiagnosisError, issues?: CodingIssue[]): NextResponse {
  const { status, error: message } = ERRORS[error]
  return NextResponse.json(issues ? { error: message, code: error, issues } : { error: message, code: error }, { status })
}

export function diagnosisFailure(err: unknown, what: string): NextResponse {
  if (err instanceof EncounterClosedError) return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
  console.error(`[encounters] diagnosis ${what} failed (code ${pgErrorCode(err) ?? 'unknown'})`)
  return NextResponse.json({ error: 'Could not save the diagnosis' }, { status: 500 })
}
