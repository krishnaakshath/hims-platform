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

// ---- Protocol (Task 7) ----

/** NHCX API version prefix (S2 Swagger). */
export const NHCX_API_VERSION_PREFIX = '/v1'

/**
 * NHCX actions, sent as `${NHCX_API_VERSION_PREFIX}/${action}`. S2 has /v1/status;
 * `on_status` is UNVERIFIED U9. There is no predetermination path in NHCX (S2).
 */
export const NHCX_ACTIONS = {
  'coverageeligibility/check': { path: 'coverageeligibility/check', entity: 'coverageeligibility', direction: 'request' },
  'coverageeligibility/on_check': { path: 'coverageeligibility/on_check', entity: 'coverageeligibility', direction: 'callback' },
  'preauth/submit': { path: 'preauth/submit', entity: 'preauth', direction: 'request' },
  'preauth/on_submit': { path: 'preauth/on_submit', entity: 'preauth', direction: 'callback' },
  'claim/submit': { path: 'claim/submit', entity: 'claim', direction: 'request' },
  'claim/on_submit': { path: 'claim/on_submit', entity: 'claim', direction: 'callback' },
  'communication/request': { path: 'communication/request', entity: 'communication', direction: 'request' },
  'communication/on_request': { path: 'communication/on_request', entity: 'communication', direction: 'callback' },
  'paymentnotice/request': { path: 'paymentnotice/request', entity: 'paymentnotice', direction: 'request' },
  'paymentnotice/on_request': { path: 'paymentnotice/on_request', entity: 'paymentnotice', direction: 'callback' },
  status: { path: 'status', entity: 'status', direction: 'request' },
  on_status: { path: 'on_status', entity: 'status', direction: 'callback' },
} as const satisfies Record<string, { path: string; entity: NhcxEntityType; direction: 'request' | 'callback' }>
export type NhcxAction = keyof typeof NHCX_ACTIONS

/**
 * What a provider accepts on its callback endpoint. An insurer's query
 * (communication/request) and payment notice (paymentnotice/request) arrive
 * as requests; a provider never accepts a submit or a check.
 */
export const ACCEPTED_INBOUND_ACTIONS = [
  'coverageeligibility/on_check', 'preauth/on_submit', 'claim/on_submit', 'communication/request', 'paymentnotice/request', 'on_status',
] as const satisfies readonly NhcxAction[]

/** HCX protocol headers (S4 v0.8). The ABHA header is S3 only (UNVERIFIED U19). */
export const HCX_HEADER = {
  sender: 'x-hcx-sender_code',
  recipient: 'x-hcx-recipient_code',
  apiCallId: 'x-hcx-api_call_id',
  correlationId: 'x-hcx-correlation_id',
  workflowId: 'x-hcx-workflow_id',
  timestamp: 'x-hcx-timestamp',
  status: 'x-hcx-status',
  errorDetails: 'x-hcx-error_details',
  debugFlag: 'x-hcx-debug_flag',
  abhaId: 'x-hcx-ben-abha-id',
} as const

/** S4 lists queued, dispatched and the four response values; S3 adds initiated and stopped. */
export const HCX_STATUS_VALUES = [
  'request.initiated', 'request.queued', 'request.dispatched', 'request.stopped', 'response.complete', 'response.partial', 'response.error', 'response.redirect',
] as const
export type HcxStatus = (typeof HCX_STATUS_VALUES)[number]

/** JWE: S4 fixes RSA-OAEP; S3 says NHCX sends RSA-OAEP-256 and accepts both (UNVERIFIED U4). */
export const JWE_ALG_SEND = 'RSA-OAEP-256'
export const JWE_ALGS_ACCEPT = ['RSA-OAEP-256', 'RSA-OAEP'] as const
export const JWE_ENC = 'A256GCM'

/** S3 claims numeric workflow stage codes; unverified (U5), so the optional header is not sent. */
export const NHCX_SEND_WORKFLOW_ID = false

/** The header carrying the gateway token on NHCX calls (S3 only, UNVERIFIED U1). */
export const NHCX_TOKEN_HEADER = 'bearer_auth'
