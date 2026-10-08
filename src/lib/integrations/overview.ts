import { certificateSummary, type CertificateSummary } from './certs'
import { capabilityStatuses, readAbdmConfig, readNhcxConfig, type CapabilityStatus } from './config'

// What the ABDM / NHCX connection page may show (SP8 Task 15, ruling 2):
// states, missing variable names, the participant code (an identifier), the
// mode, certificate subject / fingerprint prefix / expiry, and whether a
// previous key is loaded. Never a secret, a token, a key, a client id or a PEM.

type Env = Record<string, string | undefined>
export type CertView = (CertificateSummary & { warning: 'none' | 'expiring' | 'expired' }) | null

export interface IntegrationOverview {
  capabilities: CapabilityStatus[]
  mode: 'Sandbox' | 'Production' | null
  participantCode: string | null
  encryptionCert: CertView
  signingCert: CertView
  rotationInProgress: boolean
  callbackUrl: string
  bridgeUrl: string
}

const SANDBOX_HOSTS = new Set(['dev.abdm.gov.in', 'abhasbx.abdm.gov.in'])

function certView(pem: string | null, now: Date): CertView {
  if (!pem) return null
  try {
    const s = certificateSummary(pem, now)
    return { ...s, warning: s.expired ? 'expired' : s.daysLeft <= 30 ? 'expiring' : 'none' }
  } catch {
    return null
  }
}

export function integrationOverview(env: Env = process.env, now: Date = new Date()): IntegrationOverview {
  const abdm = readAbdmConfig(env)
  const nhcx = readNhcxConfig(env)
  let mode: IntegrationOverview['mode'] = null
  if (abdm.state === 'configured') {
    const hosts = [abdm.config.gatewayBaseUrl, abdm.config.abhaBaseUrl].map((u) => new URL(u).host)
    mode = hosts.some((h) => SANDBOX_HOSTS.has(h)) ? 'Sandbox' : 'Production'
  }
  const app = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '') || '<NEXT_PUBLIC_APP_URL>'
  return {
    capabilities: capabilityStatuses(env),
    mode,
    participantCode: nhcx.state === 'configured' ? nhcx.config.participantCode : null,
    encryptionCert: certView(nhcx.state === 'configured' ? nhcx.config.encryptionCertPem : null, now),
    signingCert: certView(nhcx.state === 'configured' ? nhcx.config.gatewaySigningCertPem : null, now),
    rotationInProgress: nhcx.state === 'configured' && nhcx.config.previousEncryptionPrivateKeyPem !== null,
    callbackUrl: `${app}/api/nhcx/callback`,
    bridgeUrl: `${app}/api/abdm`,
  }
}
