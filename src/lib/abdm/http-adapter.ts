import type { AbdmConfig } from '@/lib/integrations/config'
import { CAPABILITY_LABEL } from '@/lib/integrations/config'
import { safeLog } from '@/lib/integrations/safe-log'
import { formatAbhaNumber, isValidAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import { ABDM_PATHS, ENROL_CONSENT, LOGIN_ROUTES } from './constants'
import { AbdmEncryptionError, encryptForAbdm } from './encrypt'
import type { AbdmFailure, AbdmGateway, AbdmResult, AbhaProfileView } from './gateway'
import {
  ABDM_TIMEOUT_MS, AbdmHttpError, abdmHeaders, defaultSessionDeps, getAbhaPublicKey, getGatewayToken, mapAbdmFailure, refreshGatewayToken,
  timeoutSignal, type SessionDeps,
} from './session'

// The real ABHA V3 (M1) adapter. Wire shapes are from S1 (hiecm-m1.yaml and
// the M1 API pages). Every call: standard headers plus the gateway bearer
// token, a 15-second timeout, and no retry (OTP calls are not idempotent).
// Non-2xx statuses map to fixed failure keys; ABDM response bodies are read
// only for the documented success fields and never reach a message or a log.

type Json = Record<string, unknown>
type CallOk = { ok: true; body: Json }
type CallResult = CallOk | { ok: false; error: AbdmFailure }

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function maskMobile(v: unknown): string | null {
  const digits = typeof v === 'string' ? v.replace(/\D/g, '') : ''
  return digits.length >= 4 ? `******${digits.slice(-4)}` : null
}

function mapGender(v: unknown): AbhaProfileView['gender'] {
  if (v === 'M' || v === 'F' || v === 'O') return v
  if (v === 'T') return 'O'
  return null
}

function yearOf(raw: Json): number | null {
  const direct = Number(raw.yearOfBirth)
  if (Number.isInteger(direct) && direct > 1900 && direct < 2200) return direct
  const dob = asString(raw.dob) ?? asString(raw.dateOfBirth)
  const m = dob ? /(?:^|\D)(\d{4})(?:\D|$)/.exec(dob) : null
  return m ? Number(m[1]) : null
}

function nameOf(raw: Json): string {
  const direct = asString(raw.name) ?? asString(raw.fullName)
  if (direct) return direct.trim()
  return [raw.firstName, raw.middleName, raw.lastName].filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim()).join(' ')
}

/** Maps an ABHA profile body (enrolment ABHAProfile, profile/account or the PHR abha-profile). Null when it has no valid ABHA number. */
export function toProfileView(raw: unknown): AbhaProfileView | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Json
  const numberRaw = asString(r.ABHANumber) ?? asString(r.abhaNumber) ?? asString(r.healthIdNumber)
  if (!numberRaw || !isValidAbhaNumber(numberRaw)) return null
  const addresses = new Set<string>()
  for (const a of Array.isArray(r.phrAddress) ? r.phrAddress : []) if (typeof a === 'string' && a) addresses.add(a)
  for (const k of ['abhaAddress', 'preferredAbhaAddress'] as const) {
    const a = asString(r[k])
    if (a) addresses.add(a)
  }
  const list = [...addresses]
  return {
    abhaNumber: normalizeAbhaNumber(numberRaw),
    abhaAddresses: list,
    preferredAbhaAddress: asString(r.preferredAbhaAddress) ?? list[0] ?? null,
    name: nameOf(r),
    gender: mapGender(r.gender),
    yearOfBirth: yearOf(r),
    mobileMasked: maskMobile(r.mobile),
    abhaStatus: asString(r.abhaStatus),
  }
}

function tokenOf(body: Json): string | null {
  const tokens = body.tokens as Json | undefined
  return asString(body.token) ?? (tokens && typeof tokens === 'object' ? asString(tokens.token) : null)
}

export function httpAbdmGateway(cfg: AbdmConfig, deps: SessionDeps = defaultSessionDeps()): AbdmGateway {
  async function call(action: string, req: { method: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string>; otpStep?: boolean }): Promise<CallResult> {
    let token: string
    try {
      token = await getGatewayToken(cfg, deps)
    } catch (e) {
      const failure = mapAbdmFailure(e instanceof AbdmHttpError ? e.status : null)
      safeLog('abdm', { action: 'session', httpStatus: e instanceof AbdmHttpError ? (e.status ?? undefined) : undefined, outcome: failure })
      return { ok: false, error: failure === 'invalid_input' || failure === 'otp_invalid' ? 'abdm_unavailable' : failure }
    }
    const started = Date.now()
    let res: Response
    try {
      res = await deps.fetch(`${cfg.abhaBaseUrl}${req.path}`, {
        method: req.method,
        headers: abdmHeaders({ Authorization: `Bearer ${token}`, ...(req.headers ?? {}) }, deps.now()),
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: timeoutSignal(ABDM_TIMEOUT_MS),
      })
    } catch {
      safeLog('abdm', { action, outcome: 'unreachable', durationMs: Date.now() - started })
      return { ok: false, error: 'abdm_unavailable' }
    }
    safeLog('abdm', { action, httpStatus: res.status, durationMs: Date.now() - started })
    if (!res.ok) return { ok: false, error: mapAbdmFailure(res.status, { otpStep: req.otpStep }) }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, error: 'abdm_unavailable' }
    }
    if (!body || typeof body !== 'object') return { ok: false, error: 'abdm_unavailable' }
    return { ok: true, body: body as Json }
  }

  const unavailable = { ok: false, error: 'abdm_unavailable' } as const

  return {
    source: 'abdm',
    status: () => ({ state: 'configured', label: CAPABILITY_LABEL.configured }),

    async testConnection() {
      try {
        const { expiresIn } = await refreshGatewayToken(cfg, deps)
        return { ok: true, value: { tokenExpiresInSeconds: expiresIn } }
      } catch (e) {
        const failure = mapAbdmFailure(e instanceof AbdmHttpError ? e.status : null)
        return { ok: false, error: failure === 'rate_limited' ? failure : 'abdm_unavailable' }
      }
    },

    async enrolRequestAadhaarOtp({ encryptedAadhaar }) {
      const r = await call('enrol_request_otp', {
        method: 'POST', path: ABDM_PATHS.enrolRequestOtp,
        body: { txnId: '', scope: ['abha-enrol'], loginHint: 'aadhaar', loginId: encryptedAadhaar, otpSystem: 'aadhaar' },
      })
      if (!r.ok) return r
      const txnId = asString(r.body.txnId)
      return txnId ? { ok: true, value: { txnId } } : unavailable
    },

    async enrolByAadhaarOtp({ txnId, encryptedOtp, mobile }) {
      const r = await call('enrol_by_aadhaar', {
        method: 'POST', path: ABDM_PATHS.enrolByAadhaar, otpStep: true,
        body: { authData: { authMethods: ['otp'], otp: { txnId, otpValue: encryptedOtp, mobile } }, consent: { code: ENROL_CONSENT.code, version: ENROL_CONSENT.version } },
      })
      if (!r.ok) return r
      const userToken = tokenOf(r.body)
      const profile = toProfileView(r.body.ABHAProfile)
      if (!userToken || !profile) return unavailable
      return { ok: true, value: { txnId: asString(r.body.txnId) ?? txnId, userToken, profile, isNew: r.body.isNew === true } }
    },

    async enrolAddressSuggestions({ txnId }) {
      const r = await call('enrol_suggestion', { method: 'GET', path: ABDM_PATHS.enrolSuggestion, headers: { TRANSACTION_ID: txnId } })
      if (!r.ok) return r
      const list = Array.isArray(r.body.abhaAddressList) ? r.body.abhaAddressList.filter((a): a is string => typeof a === 'string' && a.length > 0) : []
      return { ok: true, value: { suggestions: list } }
    },

    async enrolSetAddress({ txnId, abhaAddress }) {
      const r = await call('enrol_abha_address', { method: 'POST', path: ABDM_PATHS.enrolAbhaAddress, body: { txnId, abhaAddress, preferred: 1 } })
      if (!r.ok) return r
      const preferred = asString(r.body.preferredAbhaAddress)
      return preferred ? { ok: true, value: { preferredAbhaAddress: preferred } } : unavailable
    },

    async loginRequestOtp({ route, encryptedLoginId }) {
      const spec = LOGIN_ROUTES[route]
      const r = await call('login_request_otp', {
        method: 'POST', path: route === 'abha_address_otp' ? ABDM_PATHS.phrRequestOtp : ABDM_PATHS.loginRequestOtp,
        body: { scope: [...spec.scope], loginHint: spec.loginHint, loginId: encryptedLoginId, otpSystem: spec.otpSystem },
      })
      if (!r.ok) return r
      const txnId = asString(r.body.txnId)
      return txnId ? { ok: true, value: { txnId } } : unavailable
    },

    async loginVerifyOtp({ route, txnId, encryptedOtp }) {
      const spec = LOGIN_ROUTES[route]
      const r = await call('login_verify', {
        method: 'POST', path: route === 'abha_address_otp' ? ABDM_PATHS.phrVerify : ABDM_PATHS.loginVerify, otpStep: true,
        body: { scope: [...spec.scope], authData: { authMethods: ['otp'], otp: { txnId, otpValue: encryptedOtp } } },
      })
      if (!r.ok) return r
      const token = tokenOf(r.body)
      if (!token) return unavailable
      const accounts = (Array.isArray(r.body.accounts) ? r.body.accounts : [])
        .map((a) => (a && typeof a === 'object' ? (a as Json) : {}))
        .map((a) => ({ raw: asString(a.ABHANumber) ?? asString(a.abhaNumber), name: asString(a.name) }))
        .filter((a): a is { raw: string; name: string | null } => a.raw !== null && isValidAbhaNumber(a.raw))
        .map((a) => ({ abhaNumber: normalizeAbhaNumber(a.raw), name: a.name }))
      // Mobile OTP returns a 300-second T-token that must be exchanged for one chosen account (S1).
      if (route === 'mobile_otp') return { ok: true, value: { userToken: null, transientToken: token, accounts } }
      return { ok: true, value: { userToken: token, transientToken: null, accounts } }
    },

    async loginSelectAccount({ transientToken, txnId, abhaNumber }) {
      const r = await call('login_verify_user', {
        method: 'POST', path: ABDM_PATHS.loginVerifyUser, headers: { 'T-token': `Bearer ${transientToken}` },
        body: { ABHANumber: formatAbhaNumber(normalizeAbhaNumber(abhaNumber)), txnId },
      })
      if (!r.ok) return r
      const userToken = tokenOf(r.body)
      return userToken ? { ok: true, value: { userToken } } : unavailable
    },

    async fetchProfile({ userToken, route }): Promise<AbdmResult<AbhaProfileView>> {
      const r = await call('profile', {
        method: 'GET', path: route === 'abha_address_otp' ? ABDM_PATHS.phrProfile : ABDM_PATHS.profileAccount, headers: { 'X-token': `Bearer ${userToken}` },
      })
      if (!r.ok) return r
      const profile = toProfileView(r.body)
      return profile ? { ok: true, value: profile } : unavailable
    },

    async encrypt(plaintext) {
      try {
        return { ok: true, value: encryptForAbdm(plaintext, await getAbhaPublicKey(cfg, deps)) }
      } catch (e) {
        if (e instanceof AbdmEncryptionError) return unavailable
        const failure = mapAbdmFailure(e instanceof AbdmHttpError ? e.status : null)
        return { ok: false, error: failure === 'rate_limited' ? failure : 'abdm_unavailable' }
      }
    },
  }
}

