import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Test-only key material, generated at run time. Never commit a key or a
// certificate (SP8 ruling 2). The certificate needs openssl on PATH (macOS
// ships LibreSSL, which is fine); callers skip the certificate cases when it
// is absent.

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function makeTestKeyPairAndCert(cn: string, days: number): { privateKeyPem: string; certPem: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const dir = mkdtempSync(path.join(tmpdir(), 'sp8-cert-'))
  try {
    const keyPath = path.join(dir, 'k.pem')
    const certPath = path.join(dir, 'c.pem')
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
    execFileSync('openssl', ['req', '-x509', '-new', '-key', keyPath, '-out', certPath, '-days', String(days), '-subj', `/CN=${cn}`], { stdio: 'ignore' })
    return { privateKeyPem, certPem: readFileSync(certPath, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
