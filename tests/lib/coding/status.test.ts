import { describe, it, expect } from 'vitest'
import {
  nextCodingStatus, statusAfterCoderEdit, doctorMayPropose, CODING_ACTION_ROLES, CODING_ACTIONS, CODING_EVENT_ACTIONS,
  ENCOUNTER_CODING_STATUSES, CODING_STATUS_LABEL, type EncounterCodingStatus, type CodingAction,
} from '@/lib/coding/status'

describe('coding status machine', () => {
  it('walks the happy path and refuses skips', () => {
    expect(nextCodingStatus('uncoded', 'claim')).toBe('in_progress'); expect(nextCodingStatus('in_progress', 'raise_query')).toBe('queried')
    expect(nextCodingStatus('queried', 'resume')).toBe('in_progress'); expect(nextCodingStatus('in_progress', 'mark_coded')).toBe('coded')
    expect(nextCodingStatus('coded', 'finalise')).toBe('finalised'); expect(nextCodingStatus('in_progress', 'finalise')).toBeNull()
    expect(nextCodingStatus('finalised', 'claim')).toBeNull(); expect(nextCodingStatus('finalised', 'reopen')).toBe('in_progress')
  })
  it('matches the full transition table', () => {
    const S = ENCOUNTER_CODING_STATUSES
    const expected: Record<CodingAction, Record<EncounterCodingStatus, EncounterCodingStatus | null>> = {
      claim: { uncoded: 'in_progress', in_progress: 'in_progress', queried: 'queried', coded: 'coded', finalised: null },
      assign: { uncoded: 'in_progress', in_progress: 'in_progress', queried: 'queried', coded: 'coded', finalised: null },
      release: { uncoded: null, in_progress: 'in_progress', queried: 'queried', coded: 'coded', finalised: null },
      raise_query: { uncoded: 'queried', in_progress: 'queried', queried: 'queried', coded: 'queried', finalised: null },
      resume: { uncoded: null, in_progress: null, queried: 'in_progress', coded: null, finalised: null },
      mark_coded: { uncoded: null, in_progress: 'coded', queried: null, coded: null, finalised: null },
      finalise: { uncoded: null, in_progress: null, queried: null, coded: 'finalised', finalised: null },
      reopen: { uncoded: null, in_progress: null, queried: null, coded: null, finalised: 'in_progress' },
    }
    for (const a of CODING_ACTIONS) for (const s of S) expect(nextCodingStatus(s, a), `${s} + ${a}`).toBe(expected[a][s])
  })
  it('a coder edit after coded reverts to in_progress; finalised refuses edits and proposals', () => {
    expect(statusAfterCoderEdit('coded')).toBe('in_progress'); expect(statusAfterCoderEdit('finalised')).toBeNull()
    expect(statusAfterCoderEdit('uncoded')).toBe('in_progress'); expect(statusAfterCoderEdit('in_progress')).toBe('in_progress'); expect(statusAfterCoderEdit('queried')).toBe('queried')
    expect(doctorMayPropose('coded')).toBe(false); expect(doctorMayPropose('queried')).toBe(true)
    expect(doctorMayPropose('uncoded')).toBe(true); expect(doctorMayPropose('in_progress')).toBe(true); expect(doctorMayPropose('finalised')).toBe(false)
  })
  it('only admin assigns', () => {
    expect(CODING_ACTION_ROLES.assign).toEqual(['admin']); expect(CODING_ACTION_ROLES.finalise).toEqual(['admin', 'coder'])
    for (const a of CODING_ACTIONS) if (a !== 'assign') expect(CODING_ACTION_ROLES[a]).toEqual(['admin', 'coder'])
  })
  it('events add edit_after_coded and labels cover every status', () => {
    expect(CODING_EVENT_ACTIONS).toEqual([...CODING_ACTIONS, 'edit_after_coded'])
    expect(CODING_STATUS_LABEL.coded).toBe('Coded, awaiting finalise'); expect(Object.keys(CODING_STATUS_LABEL)).toEqual([...ENCOUNTER_CODING_STATUSES])
  })
})
