import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { certificateSummary, decodePemEnv } from '@/lib/integrations/certs'
import { openPayload, sealPayload } from '@/lib/integrations/payload-vault'
import { hasOpenssl, makeTestKeyPairAndCert } from '../../helpers/selfsigned'

const OPENSSL = hasOpenssl()
const CERT = OPENSSL ? makeTestKeyPairAndCert('1000099@sbx', 30) : null
const savedKey = process.env.INTEGRATION_PAYLOAD_KEY
afterEach(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_PAYLOAD_KEY
  else process.env.INTEGRATION_PAYLOAD_KEY = savedKey
})

describe('certificates', () => {
  it.skipIf(!OPENSSL)('summarises a certificate without exposing key material', () => {
    const s = certificateSummary(CERT!.certPem, new Date())
    expect(s.fingerprintPrefix).toMatch(/^[0-9A-F]{16}$/)
    expect(typeof s.daysLeft).toBe('number')
    expect(s.daysLeft).toBeGreaterThanOrEqual(29)
    expect(s.expired).toBe(false)
    expect(s.subject).toContain('1000099@sbx')
    expect(JSON.stringify(s)).not.toMatch(/BEGIN/)
  })
  it.skipIf(!OPENSSL)('reports an expired certificate', () => {
    const later = new Date(Date.now() + 40 * 86_400_000)
    const s = certificateSummary(CERT!.certPem, later)
    expect(s.expired).toBe(true)
    expect(s.daysLeft).toBeLessThan(0)
  })
  it.skipIf(!OPENSSL)('decodePemEnv round-trips a base64 PEM', () => {
    expect(decodePemEnv(Buffer.from(CERT!.certPem).toString('base64'))).toBe(CERT!.certPem)
  })
  it('decodePemEnv refuses junk without echoing it', () => {
    expect(() => decodePemEnv(Buffer.from('hello').toString('base64'))).toThrow('Invalid PEM in environment')
    let msg = ''
    try { decodePemEnv(Buffer.from('secret-value-xyz').toString('base64')) } catch (e) { msg = String(e) }
    expect(msg).not.toContain('secret-value-xyz')
  })
})

describe('payload vault', () => {
  it('the vault round-trips and tampering fails', () => {
    process.env.INTEGRATION_PAYLOAD_KEY = randomBytes(32).toString('base64')
    const s = sealPayload('{"a":1}')
    expect(s).not.toContain('"a"')
    expect(openPayload(s)).toBe('{"a":1}')
    // Flip the first ciphertext character (the last one can be base64 padding).
    const [iv, tag, ct] = s.split(':')
    const tampered = [iv, tag, (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)].join(':')
    expect(() => openPayload(tampered)).toThrow()
  })
  it('a missing key is a fixed error', () => {
    delete process.env.INTEGRATION_PAYLOAD_KEY
    expect(() => sealPayload('{}')).toThrow('INTEGRATION_PAYLOAD_KEY is not set')
  })
  it('a key of the wrong length is refused', () => {
    process.env.INTEGRATION_PAYLOAD_KEY = randomBytes(16).toString('base64')
    expect(() => sealPayload('{}')).toThrow(/32 bytes/)
  })
})
