// Wave J (P1-20): pure helpers for the patient portal's UHID / mobile OTP sign-in.
import { parseUhid } from '@/lib/uhid'

export type PortalOtpIdentifier = { kind: 'uhid'; uhid: string } | { kind: 'mobile'; last10: string }

/**
 * A UHID (any case, surrounding spaces ignored) or an Indian mobile number: 10 digits, or
 * with a +91 / 91 / 0 prefix, spaces and dashes allowed. Anything else is null.
 */
export function parsePortalOtpIdentifier(raw: string): PortalOtpIdentifier | null {
  const trimmed = raw.trim()
  const upper = trimmed.toUpperCase()
  if (parseUhid(upper)) return { kind: 'uhid', uhid: upper }
  if (!/^\+?[\d\s-]+$/.test(trimmed)) return null
  const digits = trimmed.replace(/\D/g, '')
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits
  return /^[6-9]\d{9}$/.test(national) ? { kind: 'mobile', last10: national } : null
}

/** One rate-limit / lookup key per identifier, whatever spelling was typed. */
export function portalOtpIdentifierKey(id: PortalOtpIdentifier): string {
  return id.kind === 'uhid' ? `portal:uhid:${id.uhid}` : `portal:mobile:${id.last10}`
}

/** The OTP store identity of a patient (never shared with staff OTP identities). */
export function portalOtpIdentity(patientId: string): string {
  return `patient-portal:${patientId}`
}

/** A stored patient phone as +91XXXXXXXXXX for the SMS gateway, or null when it is not an Indian mobile. */
export function toIndianE164(phone: string): string | null {
  const parsed = parsePortalOtpIdentifier(phone)
  return parsed?.kind === 'mobile' ? `+91${parsed.last10}` : null
}

/** SMS sign-in needs the gateway configured; checked before any patient lookup so the answer never depends on who was asked about. */
export function isSmsSignInConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER)
}

export const PORTAL_OTP_SENT_MESSAGE = 'If these details match a portal account, a 6-digit code has been sent to the mobile number the hospital has on file.'
