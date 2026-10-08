import { decodePemEnv } from './certs'
import { mocksEnabled } from './runtime'

// The single seam through which ABDM / NHCX credentials enter the app (SP8
// ruling 2). Values come only from env; results name missing variables, never
// values. Real credentials always win over the mock flag; the mock applies
// only when the required set is incomplete and mocksEnabled() is true.

type Env = Record<string, string | undefined>

export type CapabilityState = 'configured' | 'mock' | 'not_configured'

export interface AbdmConfig {
  gatewayBaseUrl: string
  abhaBaseUrl: string
  clientId: string
  clientSecret: string
  cmId: string
  hipId: string | null
  gatewayJwksUrl: string | null
  consentTextPath: string | null
}

export interface NhcxConfig {
  apiBaseUrl: string
  participantServiceUrl: string
  participantCode: string
  encryptionPrivateKeyPem: string
  previousEncryptionPrivateKeyPem: string | null
  encryptionCertPem: string
  gatewaySigningCertPem: string | null
  callbackIpAllowlist: string[]
  maxAttachmentBytes: number
}

export type ConfigResult<T> =
  | { state: 'configured'; config: T }
  | { state: 'mock' }
  | { state: 'not_configured'; missing: string[] }

const DEFAULT_MAX_ATTACHMENT_BYTES = 10_000_000

function text(env: Env, name: string): string | null {
  const v = env[name]?.trim()
  return v ? v : null
}

/** An https URL without a trailing slash, or null (an http URL counts as missing). */
function httpsUrl(env: Env, name: string): string | null {
  const v = text(env, name)
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:') return null
  } catch {
    return null
  }
  return v.replace(/\/+$/, '')
}

function pem(env: Env, name: string): string | null {
  const v = text(env, name)
  if (!v) return null
  try {
    return decodePemEnv(v)
  } catch {
    return null
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export function readAbdmConfig(env: Env = process.env): ConfigResult<AbdmConfig> {
  const gatewayBaseUrl = httpsUrl(env, 'ABDM_GATEWAY_BASE_URL')
  const abhaBaseUrl = httpsUrl(env, 'ABHA_BASE_URL')
  const clientId = text(env, 'ABDM_CLIENT_ID')
  const clientSecret = text(env, 'ABDM_CLIENT_SECRET')
  const cmId = text(env, 'ABDM_CM_ID')
  const missing: string[] = []
  if (!gatewayBaseUrl) missing.push('ABDM_GATEWAY_BASE_URL')
  if (!abhaBaseUrl) missing.push('ABHA_BASE_URL')
  if (!clientId) missing.push('ABDM_CLIENT_ID')
  if (!clientSecret) missing.push('ABDM_CLIENT_SECRET')
  if (!cmId) missing.push('ABDM_CM_ID')
  if (missing.length > 0) return mocksEnabled(env) ? { state: 'mock' } : { state: 'not_configured', missing }
  return {
    state: 'configured',
    config: {
      gatewayBaseUrl: gatewayBaseUrl!,
      abhaBaseUrl: abhaBaseUrl!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      cmId: cmId!,
      hipId: text(env, 'ABDM_HIP_ID'),
      gatewayJwksUrl: httpsUrl(env, 'ABDM_GATEWAY_JWKS_URL'),
      consentTextPath: text(env, 'ABDM_CONSENT_TEXT_PATH'),
    },
  }
}

export function readNhcxConfig(env: Env = process.env): ConfigResult<NhcxConfig> {
  const apiBaseUrl = httpsUrl(env, 'NHCX_API_BASE_URL')
  const participantServiceUrl = httpsUrl(env, 'NHCX_PARTICIPANT_SERVICE_URL')
  const participantCode = text(env, 'NHCX_PARTICIPANT_CODE')
  const encryptionPrivateKeyPem = pem(env, 'NHCX_ENCRYPTION_PRIVATE_KEY')
  const encryptionCertPem = pem(env, 'NHCX_ENCRYPTION_CERT')
  const missing: string[] = []
  if (!apiBaseUrl) missing.push('NHCX_API_BASE_URL')
  if (!participantServiceUrl) missing.push('NHCX_PARTICIPANT_SERVICE_URL')
  if (!participantCode) missing.push('NHCX_PARTICIPANT_CODE')
  if (!encryptionPrivateKeyPem) missing.push('NHCX_ENCRYPTION_PRIVATE_KEY')
  if (!encryptionCertPem) missing.push('NHCX_ENCRYPTION_CERT')
  // NHCX authenticates with the ABDM gateway session (UNVERIFIED U3).
  const abdm = readAbdmConfig({ ...env, ABDM_USE_MOCKS: undefined })
  if (abdm.state === 'not_configured') missing.push(...abdm.missing)
  if (missing.length > 0) return mocksEnabled(env) ? { state: 'mock' } : { state: 'not_configured', missing }

  const cap = Number(text(env, 'NHCX_MAX_ATTACHMENT_BYTES'))
  return {
    state: 'configured',
    config: {
      apiBaseUrl: apiBaseUrl!,
      participantServiceUrl: participantServiceUrl!,
      participantCode: participantCode!,
      encryptionPrivateKeyPem: encryptionPrivateKeyPem!,
      previousEncryptionPrivateKeyPem: pem(env, 'NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY'),
      encryptionCertPem: encryptionCertPem!,
      gatewaySigningCertPem: pem(env, 'NHCX_GATEWAY_SIGNING_CERT'),
      callbackIpAllowlist: (text(env, 'NHCX_CALLBACK_IP_ALLOWLIST') ?? '')
        .split(',').map((s) => s.trim()).filter((s) => IPV4.test(s)),
      maxAttachmentBytes: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_ATTACHMENT_BYTES,
    },
  }
}

export type CapabilityKey = 'abha' | 'scan_share' | 'nhcx_submit' | 'nhcx_callbacks' | 'nhcx_eligibility'

export interface CapabilityStatus {
  key: CapabilityKey
  state: CapabilityState
  label: string
  missing: string[]
}

export const CAPABILITY_LABEL: Record<CapabilityState, string> = {
  configured: 'Connected',
  mock: 'Sandbox mock - not real',
  not_configured: 'Not configured',
}

function statusOf(key: CapabilityKey, base: ConfigResult<unknown>, extraMissing: string[] = []): CapabilityStatus {
  if (base.state === 'mock') return { key, state: 'mock', label: CAPABILITY_LABEL.mock, missing: [] }
  const missing = [...(base.state === 'not_configured' ? base.missing : []), ...extraMissing]
  const state: CapabilityState = missing.length === 0 ? 'configured' : 'not_configured'
  return { key, state, label: CAPABILITY_LABEL[state], missing }
}

export function capabilityStatuses(env: Env = process.env): CapabilityStatus[] {
  const abdm = readAbdmConfig(env)
  const nhcx = readNhcxConfig(env)
  const shareMissing: string[] = []
  if (!text(env, 'ABDM_HIP_ID')) shareMissing.push('ABDM_HIP_ID')
  if (!httpsUrl(env, 'ABDM_GATEWAY_JWKS_URL')) shareMissing.push('ABDM_GATEWAY_JWKS_URL')
  const callbackMissing = pem(env, 'NHCX_GATEWAY_SIGNING_CERT') ? [] : ['NHCX_GATEWAY_SIGNING_CERT']
  return [
    statusOf('abha', abdm),
    statusOf('scan_share', abdm, shareMissing),
    statusOf('nhcx_submit', nhcx),
    statusOf('nhcx_callbacks', nhcx, callbackMissing),
    statusOf('nhcx_eligibility', nhcx),
  ]
}
