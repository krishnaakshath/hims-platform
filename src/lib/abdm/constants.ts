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

// ABHA V3 (M1) and gateway paths, S1 hiecm-gateway.yaml / hiecm-m1.yaml /
// hiecm-scan-and-register.yaml. The enrolment path is spelled byAadhaar (S1).
export const ABDM_PATHS = {
  session: '/api/hiecm/gateway/v3/sessions',
  publicCert: '/abha/api/v3/profile/public/certificate',
  enrolRequestOtp: '/abha/api/v3/enrollment/request/otp',
  enrolByAadhaar: '/abha/api/v3/enrollment/enrol/byAadhaar',
  enrolAuthByAbdm: '/abha/api/v3/enrollment/auth/byAbdm',
  enrolSuggestion: '/abha/api/v3/enrollment/enrol/suggestion',
  enrolAbhaAddress: '/abha/api/v3/enrollment/enrol/abha-address',
  loginRequestOtp: '/abha/api/v3/profile/login/request/otp',
  loginVerify: '/abha/api/v3/profile/login/verify',
  loginVerifyUser: '/abha/api/v3/profile/login/verify/user',
  profileAccount: '/abha/api/v3/profile/account',
  phrSearch: '/abha/api/v3/phr/web/login/abha/search',
  phrRequestOtp: '/abha/api/v3/phr/web/login/abha/request/otp',
  phrVerify: '/abha/api/v3/phr/web/login/abha/verify',
  phrProfile: '/abha/api/v3/phr/web/login/profile/abha-profile',
  onShare: '/api/hiecm/patient-share/v3/on-share',
} as const

/** The ABHA public certificate must announce exactly this algorithm (S1 concepts/encryption.mdx). */
export const ABHA_ENCRYPTION_ALGORITHM = 'RSA/ECB/OAEPWithSHA-1AndMGF1Padding'

/** Consent code and version sent with an ABHA enrolment (S1). */
export const ENROL_CONSENT = { code: 'abha-enrollment', version: '1.4' } as const

export type LoginRouteSpec = { scope: string[]; loginHint: string; otpSystem: 'aadhaar' | 'abdm' }

/** ABHA verification routes (S1 M1 login). abha_address_otp uses the PHR paths. */
export const LOGIN_ROUTES = {
  abha_number_aadhaar_otp: { scope: ['abha-login', 'aadhaar-verify'], loginHint: 'abha-number', otpSystem: 'aadhaar' },
  abha_number_mobile_otp: { scope: ['abha-login', 'mobile-verify'], loginHint: 'abha-number', otpSystem: 'abdm' },
  mobile_otp: { scope: ['abha-login', 'mobile-verify'], loginHint: 'mobile', otpSystem: 'abdm' },
  aadhaar_otp_login: { scope: ['abha-login', 'aadhaar-verify'], loginHint: 'aadhaar', otpSystem: 'aadhaar' },
  abha_address_otp: { scope: ['abha-address-login', 'mobile-verify'], loginHint: 'abha-address', otpSystem: 'abdm' },
} as const satisfies Record<string, LoginRouteSpec>

/** The only messages a browser ever sees for an ABDM failure. ABDM response bodies are never echoed. */
export const ABDM_ERROR_COPY = {
  not_configured: 'ABDM is not configured',
  otp_invalid: 'The OTP is incorrect or has expired',
  rate_limited: 'Too many attempts; wait a minute and try again',
  abdm_unavailable: 'ABDM did not respond; try again shortly',
  invalid_input: 'Check the number and try again',
  flow_expired: 'This verification has expired; start again',
  consent_missing: 'Record the patient\'s consent first',
  consent_text_missing: 'ABHA creation is not available until the NHA consent text is installed (see docs/ABDM-NHCX.md)',
  abha_conflict: 'This ABHA is already linked to another patient',
  account_choice_required: 'Choose which ABHA to link',
} as const
