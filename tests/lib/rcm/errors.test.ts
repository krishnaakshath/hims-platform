import { describe, it, expect } from 'vitest'
import { RCM_ERRORS, RCM_ERROR_STATUS, RCM_ERROR_MESSAGE } from '@/lib/rcm/errors'

describe('RCM error catalogue', () => {
  it('every error has a status and a message', () => { for (const e of RCM_ERRORS) { expect(RCM_ERROR_STATUS[e]).toBeDefined(); expect(RCM_ERROR_MESSAGE[e].length).toBeGreaterThan(5) } })
  it('statuses follow the plan', () => {
    expect(RCM_ERROR_STATUS.claim_not_found).toBe(404); expect(RCM_ERROR_STATUS.same_approver).toBe(403); expect(RCM_ERROR_STATUS.not_ready).toBe(422)
    expect(RCM_ERROR_STATUS.upload_invalid).toBe(400); expect(RCM_ERROR_STATUS.stale).toBe(409); expect(RCM_ERROR_STATUS.duplicate_utr).toBe(409)
    expect(RCM_ERROR_MESSAGE.gateway_not_configured).toBe('NHCX is not connected yet; submit through the insurer portal or email and record it')
  })
})
