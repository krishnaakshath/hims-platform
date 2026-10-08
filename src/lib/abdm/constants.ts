// SP8 ABDM (ABHA, milestone M1) constants. Pure and client-safe.
// Sources: S1 (NHA docs repo, hiecm v3 OpenAPI) as listed in
// docs/superpowers/plans/2026-10-07-sp8-abdm-nhcx.md.

/** Who verified an ABHA: the real ABDM, or the labelled sandbox mock (ruling 1). */
export const ABHA_VERIFICATION_SOURCES = ['abdm', 'abdm_sandbox_mock'] as const
export type AbhaVerificationSource = (typeof ABHA_VERIFICATION_SOURCES)[number]

/** How an ABHA was verified. */
export const ABHA_VERIFIED_VIA = [
  'aadhaar_otp_enrolment', 'abha_number_aadhaar_otp', 'abha_number_mobile_otp', 'mobile_otp', 'aadhaar_otp_login', 'abha_address_otp', 'scan_and_share',
] as const
export type AbhaVerifiedVia = (typeof ABHA_VERIFIED_VIA)[number]

/** What an ABDM consent row was captured for. */
export const ABDM_CONSENT_PURPOSES = ['abha_enrolment', 'abha_verification'] as const
export type AbdmConsentPurpose = (typeof ABDM_CONSENT_PURPOSES)[number]

export const ABDM_CONSENT_GIVEN_BY = ['patient', 'guardian'] as const
export type AbdmConsentGivenBy = (typeof ABDM_CONSENT_GIVEN_BY)[number]

/** Scan & Share queue states. An expired row has every profile column scrubbed. */
export const PROFILE_SHARE_STATUSES = ['pending', 'registered', 'linked', 'dismissed', 'expired'] as const
export type ProfileShareStatus = (typeof PROFILE_SHARE_STATUSES)[number]

export const PROFILE_SHARE_ACK_STATES = ['pending', 'sent', 'failed'] as const
export type ProfileShareAckState = (typeof PROFILE_SHARE_ACK_STATES)[number]
