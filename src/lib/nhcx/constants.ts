// SP8 NHCX constants. Pure and client-safe.
// Sources: S2 (NHCX Swagger), S3 (NHCX atoms, secondary), S4 (HCX protocol
// v0.8) as listed in docs/superpowers/plans/2026-10-07-sp8-abdm-nhcx.md.

/** The resource family an exchange carries. */
export const NHCX_ENTITY_TYPES = ['coverageeligibility', 'preauth', 'claim', 'communication', 'paymentnotice', 'status'] as const
export type NhcxEntityType = (typeof NHCX_ENTITY_TYPES)[number]

export const NHCX_DIRECTIONS = ['outbound', 'inbound'] as const
export type NhcxDirection = (typeof NHCX_DIRECTIONS)[number]

/**
 * Exchange lifecycle. Outbound: pending_send -> sent (202 from NHCX) -> queued /
 * dispatched (protocol status) -> responded, or send_failed / error / no_response.
 * Inbound: received -> acknowledged.
 */
export const NHCX_EXCHANGE_STATES = ['pending_send', 'sent', 'send_failed', 'queued', 'dispatched', 'responded', 'error', 'no_response', 'received', 'acknowledged'] as const
export type NhcxExchangeState = (typeof NHCX_EXCHANGE_STATES)[number]

/** An insurer response is never applied by itself (ruling 6): an RCM user confirms or dismisses it. */
export const NHCX_REVIEW_STATES = ['not_needed', 'pending', 'confirmed', 'dismissed'] as const
export type NhcxReviewState = (typeof NHCX_REVIEW_STATES)[number]

/** CoverageEligibilityRequest.purpose (FHIR R4 eligibilityrequest-purpose). */
export const ELIGIBILITY_PURPOSES = ['validation', 'benefits', 'auth-requirements', 'discovery'] as const
export type EligibilityPurpose = (typeof ELIGIBILITY_PURPOSES)[number]

export const ELIGIBILITY_CONTEXTS = ['registration', 'admission', 'preauth', 'manual'] as const
export type EligibilityContext = (typeof ELIGIBILITY_CONTEXTS)[number]

export const ELIGIBILITY_STATUSES = ['pending', 'eligible', 'not_eligible', 'error', 'no_response'] as const
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number]

export const INBOUND_CALL_OUTCOMES = ['accepted', 'rejected'] as const
export type InboundCallOutcome = (typeof INBOUND_CALL_OUTCOMES)[number]

/**
 * What an exchange row keeps of a response: no free text and no references
 * (the full payload stays vault-sealed in payload_encrypted).
 */
export type NhcxResponseSummary = {
  outcome: 'queued' | 'complete' | 'partial' | 'error' | null
  use: 'claim' | 'preauthorization' | null
  submittedPaise: number | null
  benefitPaise: number | null
  preAuthRefPresent: boolean
  inforce: boolean | null
  errorCodes: string[]
  adjudicationReasonCodes: string[]
  paymentAmountPaise: number | null
  paymentDate: string | null
  hasQueryText: boolean
}
