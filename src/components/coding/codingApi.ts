// Client fetch helpers for every SP6 coding route (Task 9 writes, Task 6 code search). Each returns
// `{ ok: true, data }` or `{ ok: false, error, issues? }`, where `error` is the server's own message
// (the catalogue text, 'Forbidden', or the 409 "try again" message) so the UI can show it as is.
import type { CodeSystemKind } from '@/lib/coding/code-systems'
import type { CodingIssue } from '@/lib/coding/rules'
import type { CodingQueryStatus, EncounterCodingStatus } from '@/lib/coding/status'
import type {
  AddDiagnosisRequest, AddProcedureRequest, CodingStatusRequest, UpdateDiagnosisRequest, UpdateProcedureRequest,
} from '@/lib/coding/validation'
import type { CodeSearchHit } from '@/lib/queries/code-systems'

export type { CodeSearchHit }

export type CodingApiResult<T> = { ok: true; data: T } | { ok: false; error: string; issues?: CodingIssue[] }

export const NETWORK_ERROR = 'Could not reach the server. Check your connection and try again.'
const FALLBACK_ERROR = 'The change could not be saved.'

async function call<T>(url: string, init: RequestInit = {}): Promise<CodingApiResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return { ok: false, error: NETWORK_ERROR }
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown; issues?: unknown }) | null
  if (res.ok) return { ok: true, data: body as T }
  const error = body && typeof body.error === 'string' ? body.error : FALLBACK_ERROR
  const issues = body && Array.isArray(body.issues) ? (body.issues as CodingIssue[]) : undefined
  return issues ? { ok: false, error, issues } : { ok: false, error }
}

const send = <T>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
  call<T>(url, body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const enc = (encounterId: number) => `/api/coding/encounters/${encounterId}`

/** Status actions: claim, assign, release, resume, mark_coded, finalise, reopen. */
export const postCodingAction = (encounterId: number, req: CodingStatusRequest) =>
  send<{ status: EncounterCodingStatus; issues: CodingIssue[] }>('POST', `${enc(encounterId)}/status`, req)

export const addDiagnosis = (encounterId: number, req: AddDiagnosisRequest) =>
  send<{ id: number; warnings: CodingIssue[] }>('POST', `${enc(encounterId)}/diagnoses`, req)
export const updateDiagnosis = (encounterId: number, diagnosisId: number, req: UpdateDiagnosisRequest) =>
  send<{ id: number; warnings: CodingIssue[] }>('PATCH', `${enc(encounterId)}/diagnoses/${diagnosisId}`, req)
export const removeDiagnosis = (encounterId: number, diagnosisId: number) =>
  send<{ ok: true }>('DELETE', `${enc(encounterId)}/diagnoses/${diagnosisId}`)

export const addProcedure = (encounterId: number, req: AddProcedureRequest) =>
  send<{ id: number; warnings: CodingIssue[] }>('POST', `${enc(encounterId)}/procedures`, req)
export const updateProcedure = (encounterId: number, procedureId: number, req: UpdateProcedureRequest) =>
  send<{ id: number; warnings: CodingIssue[] }>('PATCH', `${enc(encounterId)}/procedures/${procedureId}`, req)
export const removeProcedure = (encounterId: number, procedureId: number) =>
  send<{ ok: true }>('DELETE', `${enc(encounterId)}/procedures/${procedureId}`)

export const raiseCodingQuery = (encounterId: number, req: { addressedToProviderId: number; question: string }) =>
  send<{ id: number }>('POST', `${enc(encounterId)}/queries`, req)
export const closeCodingQuery = (queryId: number, action: 'close' | 'withdraw') =>
  send<{ status: CodingQueryStatus }>('PATCH', `/api/coding/queries/${queryId}`, { action })
export const replyToCodingQuery = (queryId: number, body: string) =>
  send<{ id: number }>('POST', `/api/coding/queries/${queryId}/responses`, { body })

export interface CodeSearchResult {
  codeSystem: { id: number; version: string; isSample: boolean } | null
  hits: CodeSearchHit[]
}

/** GET /api/coding/codes. Rethrows an abort so a superseded search can be ignored. */
export function searchCodeSet(kind: CodeSystemKind, q: string, onDate: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ kind, q, on: onDate })
  return call<CodeSearchResult>(`/api/coding/codes?${params.toString()}`, signal ? { signal } : {})
}
