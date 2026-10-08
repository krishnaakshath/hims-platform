import { X509Certificate } from 'node:crypto'

// PEM values arrive from env as one-line base64 (SP8 ruling 2). Error
// messages never carry the value.

export function decodePemEnv(value: string): string {
  let pem = ''
  try {
    pem = Buffer.from(value.trim(), 'base64').toString('utf8')
  } catch {
    pem = ''
  }
  if (!pem.includes('-----BEGIN')) throw new Error('Invalid PEM in environment')
  return pem
}

export type CertificateSummary = { subject: string; fingerprintPrefix: string; validTo: string; daysLeft: number; expired: boolean }

/** What the settings page may show: subject, fingerprint prefix, expiry. Never key material. */
export function certificateSummary(pem: string, now: Date = new Date()): CertificateSummary {
  const cert = new X509Certificate(pem)
  const validTo = new Date(cert.validTo)
  const msLeft = validTo.getTime() - now.getTime()
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    fingerprintPrefix: cert.fingerprint256.replace(/:/g, '').slice(0, 16).toUpperCase(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor(msLeft / 86_400_000),
    expired: msLeft <= 0,
  }
}
