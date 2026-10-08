import { z } from 'zod'
import { ABDM_CONSENT_GIVEN_BY, ABDM_CONSENT_PURPOSES, LOGIN_ROUTES } from '@/lib/abdm/constants'
import type { LoginRoute } from '@/lib/abdm/gateway'
import { isValidAadhaar, normalizeAadhaar } from '@/lib/india/aadhaar'
import { formatAbhaNumber, isValidAbhaAddress, isValidAbhaNumber, normalizeAbhaAddress, normalizeAbhaNumber } from '@/lib/india/abha'

// Request bodies of the ABHA create/verify routes (SP8 Task 5). Every object
// is strict. Messages are fixed strings: a refused national ID number, OTP or
// login id is never echoed, and routes return only these messages, never the
// zod issue list.

const flowId = z.uuid()
const patientId = z.string().trim().min(1).max(40)
const otp = z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP')
const mobile = z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number')

export const AADHAAR_FORMAT_MESSAGE = 'Enter a valid 12-digit Aadhaar number'

export const consentSchema = z.object({
  flowId: flowId.optional(),
  patientId: patientId.optional(),
  purpose: z.enum(ABDM_CONSENT_PURPOSES),
  givenBy: z.enum(ABDM_CONSENT_GIVEN_BY),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export const enrolOtpSchema = z.object({
  flowId,
  aadhaar: z.string().max(20).refine((v) => isValidAadhaar(normalizeAadhaar(v)), AADHAAR_FORMAT_MESSAGE).transform(normalizeAadhaar),
}).strict()

export const enrolVerifySchema = z.object({ flowId, otp, mobile }).strict()

export const addressSchema = z.object({
  flowId,
  // The local part, or a full address; ABDM appends the suffix (S1).
  abhaAddress: z.string().trim().toLowerCase().max(40).refine((v) => isValidAbhaAddress(v.includes('@') ? v : `${v}@sbx`), 'Enter a valid ABHA address'),
}).strict()

const LOGIN_ROUTE_KEYS = Object.keys(LOGIN_ROUTES) as [LoginRoute, ...LoginRoute[]]

function loginIdValid(route: LoginRoute, v: string): boolean {
  switch (route) {
    case 'abha_number_aadhaar_otp':
    case 'abha_number_mobile_otp':
      return isValidAbhaNumber(v)
    case 'mobile_otp':
      return /^[6-9]\d{9}$/.test(v.trim())
    case 'aadhaar_otp_login':
      return isValidAadhaar(v)
    case 'abha_address_otp':
      return isValidAbhaAddress(v)
  }
}

export const loginOtpSchema = z.object({
  flowId: flowId.optional(),
  patientId: patientId.optional(),
  route: z.enum(LOGIN_ROUTE_KEYS),
  loginId: z.string().max(60),
}).strict().superRefine((v, ctx) => {
  if (!loginIdValid(v.route, v.loginId)) ctx.addIssue({ code: 'custom', path: ['loginId'], message: 'Check the number and try again' })
})

/**
 * The login id as ABDM expects it before encryption: an ABHA number dashed
 * (S1: bare digits are refused), a mobile as 10 digits, an ABHA address as
 * typed (normalised), the national ID as 12 digits.
 */
export function loginIdForWire(route: LoginRoute, loginId: string): string {
  switch (route) {
    case 'abha_number_aadhaar_otp':
    case 'abha_number_mobile_otp':
      return formatAbhaNumber(normalizeAbhaNumber(loginId))
    case 'mobile_otp':
      return loginId.trim()
    case 'aadhaar_otp_login':
      return normalizeAadhaar(loginId)
    case 'abha_address_otp':
      return normalizeAbhaAddress(loginId)
  }
}

export const loginVerifySchema = z.object({ flowId, otp }).strict()
/** The account is chosen by its position in the masked list the server returned. */
export const accountSchema = z.object({ flowId, accountIndex: z.number().int().min(0).max(19) }).strict()
export const linkSchema = z.object({ flowId }).strict()
