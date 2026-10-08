import type { CapabilityState } from '@/lib/integrations/config'
import type { ABDM_ERROR_COPY, LOGIN_ROUTES } from './constants'

// The ABHA (ABDM M1) gateway interface. Two implementations: the real ABHA V3
// HTTP adapter (http-adapter.ts) and the labelled sandbox mock
// (mock-adapter.ts), chosen only by registry.ts. Callers pass values that are
// already encrypted (`encrypt` first); results carry only fixed failure keys,
// never an ABDM response body.

export type AbdmFailure = keyof typeof ABDM_ERROR_COPY
export type AbdmResult<T> = { ok: true; value: T } | { ok: false; error: AbdmFailure }

export interface AbhaProfileView {
  /** 14 digits, normalised. */
  abhaNumber: string
  abhaAddresses: string[]
  preferredAbhaAddress: string | null
  name: string
  gender: 'M' | 'F' | 'O' | null
  yearOfBirth: number | null
  /** `******` plus the last four digits, or null. */
  mobileMasked: string | null
  abhaStatus: string | null
}

export type LoginRoute = keyof typeof LOGIN_ROUTES

export interface AbdmGateway {
  readonly source: 'abdm' | 'abdm_sandbox_mock'
  status(): { state: CapabilityState; label: string }
  testConnection(): Promise<AbdmResult<{ tokenExpiresInSeconds: number }>>
  enrolRequestAadhaarOtp(input: { encryptedAadhaar: string }): Promise<AbdmResult<{ txnId: string }>>
  enrolByAadhaarOtp(input: { txnId: string; encryptedOtp: string; mobile: string }): Promise<AbdmResult<{ txnId: string; userToken: string; profile: AbhaProfileView; isNew: boolean }>>
  enrolAddressSuggestions(input: { txnId: string }): Promise<AbdmResult<{ suggestions: string[] }>>
  enrolSetAddress(input: { txnId: string; abhaAddress: string }): Promise<AbdmResult<{ preferredAbhaAddress: string }>>
  loginRequestOtp(input: { route: LoginRoute; encryptedLoginId: string }): Promise<AbdmResult<{ txnId: string }>>
  loginVerifyOtp(input: { route: LoginRoute; txnId: string; encryptedOtp: string }): Promise<AbdmResult<{ userToken: string | null; transientToken: string | null; accounts: { abhaNumber: string; name: string | null }[] }>>
  loginSelectAccount(input: { transientToken: string; txnId: string; abhaNumber: string }): Promise<AbdmResult<{ userToken: string }>>
  fetchProfile(input: { userToken: string; route: LoginRoute | 'enrolment' }): Promise<AbdmResult<AbhaProfileView>>
  encrypt(plaintext: string): Promise<AbdmResult<string>>
}
