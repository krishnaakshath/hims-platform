// Encounter coding status machine and shared enums (SP6). Pure and client-safe.
import type { Role } from '@/lib/auth'

export const DIAGNOSIS_TYPES = ['primary', 'secondary', 'provisional'] as const
export const CODE_ENTRY_STATUSES = ['uncoded', 'proposed', 'coded'] as const
export const ENCOUNTER_CODING_STATUSES = ['uncoded', 'in_progress', 'queried', 'coded', 'finalised'] as const
export const CODING_QUERY_STATUSES = ['open', 'answered', 'closed', 'withdrawn'] as const
export const CODING_ACTIONS = ['claim', 'assign', 'release', 'raise_query', 'resume', 'mark_coded', 'finalise', 'reopen'] as const
export const CODING_EVENT_ACTIONS = [...CODING_ACTIONS, 'edit_after_coded'] as const

export type DiagnosisType = (typeof DIAGNOSIS_TYPES)[number]
export type CodeEntryStatus = (typeof CODE_ENTRY_STATUSES)[number]
export type EncounterCodingStatus = (typeof ENCOUNTER_CODING_STATUSES)[number]
export type CodingQueryStatus = (typeof CODING_QUERY_STATUSES)[number]
export type CodingAction = (typeof CODING_ACTIONS)[number]
export type CodingEventAction = (typeof CODING_EVENT_ACTIONS)[number]

type S = EncounterCodingStatus

/** Next status for an action, or null when the action is not possible from `from`. */
export function nextCodingStatus(from: S, action: CodingAction): S | null {
  switch (action) {
    case 'claim':
    case 'assign':
      if (from === 'uncoded') return 'in_progress'
      return from === 'finalised' ? null : from
    case 'release':
      return from === 'in_progress' || from === 'queried' || from === 'coded' ? from : null
    case 'raise_query':
      return from === 'finalised' ? null : 'queried'
    case 'resume':
      return from === 'queried' ? 'in_progress' : null
    case 'mark_coded':
      return from === 'in_progress' ? 'coded' : null
    case 'finalise':
      return from === 'coded' ? 'finalised' : null
    case 'reopen':
      return from === 'finalised' ? 'in_progress' : null
  }
}

/** Status after a coder changes a code; null when the encounter is finalised (no edits). */
export function statusAfterCoderEdit(from: S): S | null {
  switch (from) {
    case 'uncoded': return 'in_progress'
    case 'in_progress': return 'in_progress'
    case 'queried': return 'queried'
    case 'coded': return 'in_progress'
    case 'finalised': return null
  }
}

export function doctorMayPropose(status: S): boolean {
  return status === 'uncoded' || status === 'in_progress' || status === 'queried'
}

export const CODING_ACTION_ROLES: Record<CodingAction, readonly Role[]> = {
  claim: ['admin', 'coder'],
  assign: ['admin'],
  release: ['admin', 'coder'],
  raise_query: ['admin', 'coder'],
  resume: ['admin', 'coder'],
  mark_coded: ['admin', 'coder'],
  finalise: ['admin', 'coder'],
  reopen: ['admin', 'coder'],
}

export const CODING_STATUS_LABEL: Record<S, string> = {
  uncoded: 'Not started',
  in_progress: 'In progress',
  queried: 'Query open',
  coded: 'Coded, awaiting finalise',
  finalised: 'Finalised',
}
