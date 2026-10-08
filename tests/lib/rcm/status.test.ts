import { describe, it, expect } from 'vitest'
import { nextPreauthStatus, preauthReferenceStatus, PREAUTH_ACTIONS, PREAUTH_STATUSES, PREAUTH_STATUS_LABEL } from '@/lib/rcm/preauth-status'
import { nextClaimStatus, approvalActionFor, claimWorklists, CLAIM_STATUSES, CLAIM_STATUS_LABEL, CLAIM_EVENT_ACTIONS } from '@/lib/rcm/claim-status'
import { formatRcmNumber } from '@/lib/rcm/constants'

describe('pre-auth status machine', () => {
  it('pre-auth walks request, query, response, approval, enhancement', () => {
    expect(nextPreauthStatus('draft', 'request')).toBe('requested'); expect(nextPreauthStatus('requested', 'record_query')).toBe('queried')
    expect(nextPreauthStatus('queried', 'respond_query')).toBe('requested'); expect(nextPreauthStatus('requested', 'approve')).toBe('approved')
    expect(nextPreauthStatus('approved', 'request_enhancement')).toBe('enhancement_requested'); expect(nextPreauthStatus('enhancement_requested', 'record_query')).toBe('enhancement_queried')
    expect(nextPreauthStatus('enhancement_queried', 'approve_enhancement')).toBe('enhanced')
  })
  it('a rejected enhancement falls back to the last approval', () => {
    expect(nextPreauthStatus('enhancement_requested', 'reject_enhancement', { enhancedBefore: false })).toBe('approved')
    expect(nextPreauthStatus('enhancement_requested', 'reject_enhancement', { enhancedBefore: true })).toBe('enhanced')
    expect(nextPreauthStatus('enhancement_queried', 'respond_query')).toBe('enhancement_requested')
  })
  it('terminal pre-auths refuse every action', () => { for (const a of PREAUTH_ACTIONS) { expect(nextPreauthStatus('rejected', a)).toBeNull(); expect(nextPreauthStatus('cancelled', a)).toBeNull() } })
  it('cancel works from every live status; approval only from requested or queried', () => {
    for (const s of PREAUTH_STATUSES) if (s !== 'rejected' && s !== 'cancelled') expect(nextPreauthStatus(s, 'cancel')).toBe('cancelled')
    expect(nextPreauthStatus('queried', 'approve')).toBe('approved'); expect(nextPreauthStatus('draft', 'approve')).toBeNull()
    expect(nextPreauthStatus('enhanced', 'request_enhancement')).toBe('enhancement_requested'); expect(nextPreauthStatus('approved', 'approve_enhancement')).toBeNull()
  })
  it('every status has a label', () => { for (const s of PREAUTH_STATUSES) expect(PREAUTH_STATUS_LABEL[s].length).toBeGreaterThan(2) })
  it('reference status checks in order', () => {
    const p = { status: 'approved' as const, payerIds: [7, 9], validUntil: '2026-10-31' }
    expect(preauthReferenceStatus(null, { payerId: 7, serviceDate: '2026-10-20' })).toBe('not_found')
    expect(preauthReferenceStatus({ ...p, status: 'queried' }, { payerId: 7, serviceDate: '2026-10-20' })).toBe('not_approved')
    expect(preauthReferenceStatus(p, { payerId: 8, serviceDate: '2026-10-20' })).toBe('payer_mismatch')
    expect(preauthReferenceStatus(p, { payerId: 9, serviceDate: '2026-11-01' })).toBe('expired')
    expect(preauthReferenceStatus(p, { payerId: null, serviceDate: '2026-10-31' })).toBe('valid')
  })
})

describe('claim status machine', () => {
  it('claim happy path, query loop and appeal loop', () => {
    const c = { hasSettlement: false }
    expect(nextClaimStatus('draft', 'submit', c)).toBe('submitted'); expect(nextClaimStatus('submitted', 'record_query', c)).toBe('queried')
    expect(nextClaimStatus('queried', 'respond_query', c)).toBe('submitted'); expect(nextClaimStatus('submitted', 'record_partial_approval', c)).toBe('partially_approved')
    expect(nextClaimStatus('partially_approved', 'appeal', c)).toBe('appealed'); expect(nextClaimStatus('appealed', 'record_approval', c)).toBe('approved')
    expect(nextClaimStatus('approved', 'record_settlement', c)).toBe('settled'); expect(nextClaimStatus('settled', 'close', c)).toBe('closed')
    expect(nextClaimStatus('draft', 'record_settlement', c)).toBeNull(); expect(nextClaimStatus('closed', 'withdraw', c)).toBeNull()
  })
  it('rejection, withdrawal and appeal sources', () => {
    const c = { hasSettlement: false }
    expect(nextClaimStatus('queried', 'record_rejection', c)).toBe('rejected'); expect(nextClaimStatus('appealed', 'record_query', c)).toBe('queried')
    expect(nextClaimStatus('queried', 'withdraw', c)).toBe('withdrawn'); expect(nextClaimStatus('approved', 'withdraw', c)).toBeNull()
    expect(nextClaimStatus('settled', 'appeal', c)).toBe('appealed'); expect(nextClaimStatus('approved', 'appeal', c)).toBeNull()
    expect(nextClaimStatus('rejected', 'close', c)).toBe('closed'); expect(nextClaimStatus('settled', 'record_settlement', c)).toBe('settled')
  })
  it('reopen returns to settled or rejected', () => {
    expect(nextClaimStatus('closed', 'reopen', { hasSettlement: true })).toBe('settled'); expect(nextClaimStatus('closed', 'reopen', { hasSettlement: false })).toBe('rejected')
    expect(nextClaimStatus('settled', 'reopen', { hasSettlement: true })).toBeNull()
    // Review finding 8: an approved claim written off in full can be closed (closeProblems decides).
    expect(nextClaimStatus('approved', 'close', { hasSettlement: false })).toBe('closed'); expect(nextClaimStatus('partially_approved', 'close', { hasSettlement: false })).toBe('closed')
  })
  it('approval action follows the amounts', () => { expect(approvalActionFor(100, 100)).toBe('record_approval'); expect(approvalActionFor(100, 60)).toBe('record_partial_approval') })
  it('worklists can overlap', () => {
    expect(claimWorklists({ status: 'settled', unreconciledSettlements: 1, openDenialPaise: 500 })).toEqual(['to_reconcile', 'denied'])
    expect(claimWorklists({ status: 'draft', unreconciledSettlements: 0, openDenialPaise: 0 })).toEqual(['to_submit'])
    expect(claimWorklists({ status: 'rejected', unreconciledSettlements: 0, openDenialPaise: 0 })).toEqual(['denied'])
    expect(claimWorklists({ status: 'partially_approved', unreconciledSettlements: 0, openDenialPaise: 10 })).toEqual(['awaiting_insurer', 'denied'])
    expect(claimWorklists({ status: 'closed', unreconciledSettlements: 0, openDenialPaise: 0 })).toEqual([])
  })
  it('every status has a label; events add note', () => { for (const s of CLAIM_STATUSES) expect(CLAIM_STATUS_LABEL[s].length).toBeGreaterThan(2); expect(CLAIM_EVENT_ACTIONS.at(-1)).toBe('note') })
  it('formats claim numbers', () => {
    expect(formatRcmNumber('CLM', '2026', 123)).toBe('CLM-2026-000123'); expect(() => formatRcmNumber('PA', '2026', 1_000_000)).toThrow(RangeError)
    expect(() => formatRcmNumber('PA', '2026', 0)).toThrow(RangeError); expect(() => formatRcmNumber('PA', '26', 1)).toThrow(RangeError)
    expect(formatRcmNumber('PA', '2099', 999_999)).toBe('PA-2099-999999')
  })
})
