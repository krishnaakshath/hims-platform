import { describe, it, expect } from 'vitest'
import { isProductionRuntime, mocksEnabled } from '@/lib/integrations/runtime'
import { capabilityStatuses, readAbdmConfig, readNhcxConfig } from '@/lib/integrations/config'

const FULL_ABDM = {
  ABDM_GATEWAY_BASE_URL: 'https://dev.abdm.gov.in',
  ABHA_BASE_URL: 'https://abhasbx.abdm.gov.in',
  ABDM_CLIENT_ID: 'cid',
  ABDM_CLIENT_SECRET: 'csec',
  ABDM_CM_ID: 'sbx',
}
const b64 = (s: string) => Buffer.from(s).toString('base64')
const FULL_NHCX: Record<string, string | undefined> = {
  ...FULL_ABDM,
  NHCX_API_BASE_URL: 'https://apisbx.abdm.gov.in/hcx',
  NHCX_PARTICIPANT_SERVICE_URL: 'https://apisbx.abdm.gov.in/hcx/participant',
  NHCX_PARTICIPANT_CODE: '1000099@sbx',
  NHCX_ENCRYPTION_PRIVATE_KEY: b64('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'),
  NHCX_ENCRYPTION_CERT: b64('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'),
}

describe('runtime flags', () => {
  it('mocks are off in production even with the flag', () => {
    expect(mocksEnabled({ ABDM_USE_MOCKS: '1', NODE_ENV: 'production' })).toBe(false)
    expect(mocksEnabled({ ABDM_USE_MOCKS: '1', VERCEL_ENV: 'production', NODE_ENV: 'development' })).toBe(false)
    expect(mocksEnabled({ ABDM_USE_MOCKS: '1', NODE_ENV: 'development' })).toBe(true)
    expect(mocksEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(mocksEnabled({ ABDM_USE_MOCKS: 'true', NODE_ENV: 'development' })).toBe(false)
  })
  it('production is NODE_ENV or VERCEL_ENV production', () => {
    expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionRuntime({ VERCEL_ENV: 'production' })).toBe(true)
    expect(isProductionRuntime({ VERCEL_ENV: 'preview', NODE_ENV: 'test' })).toBe(false)
  })
})

describe('ABDM config', () => {
  it('ABDM is not configured and lists only missing names', () => {
    const r = readAbdmConfig({ ABDM_CLIENT_ID: 'x', ABDM_CLIENT_SECRET: 'super-secret' })
    expect(r).toEqual({ state: 'not_configured', missing: ['ABDM_GATEWAY_BASE_URL', 'ABHA_BASE_URL', 'ABDM_CM_ID'] })
    expect(JSON.stringify(r)).not.toContain('super-secret')
  })
  it('an http base URL counts as missing', () => {
    expect(readAbdmConfig({ ...FULL_ABDM, ABHA_BASE_URL: 'http://abhasbx.abdm.gov.in' })).toMatchObject({ state: 'not_configured', missing: ['ABHA_BASE_URL'] })
  })
  it('real credentials win over the mock flag', () => {
    expect(readAbdmConfig({ ...FULL_ABDM, ABDM_USE_MOCKS: '1', NODE_ENV: 'development' }).state).toBe('configured')
  })
  it('incomplete credentials with the flag outside production is the mock', () => {
    expect(readAbdmConfig({ ABDM_USE_MOCKS: '1', NODE_ENV: 'development' })).toEqual({ state: 'mock' })
    expect(readAbdmConfig({ ABDM_USE_MOCKS: '1', NODE_ENV: 'production' }).state).toBe('not_configured')
  })
  it('a configured ABDM carries the optional values or null', () => {
    const r = readAbdmConfig({ ...FULL_ABDM, ABDM_HIP_ID: 'HFR1' })
    expect(r).toEqual({
      state: 'configured',
      config: {
        gatewayBaseUrl: 'https://dev.abdm.gov.in', abhaBaseUrl: 'https://abhasbx.abdm.gov.in', clientId: 'cid', clientSecret: 'csec',
        cmId: 'sbx', hipId: 'HFR1', gatewayJwksUrl: null, consentTextPath: null,
      },
    })
  })
  it('trailing slashes are dropped from base URLs', () => {
    const r = readAbdmConfig({ ...FULL_ABDM, ABDM_GATEWAY_BASE_URL: 'https://dev.abdm.gov.in/' })
    expect(r.state === 'configured' && r.config.gatewayBaseUrl).toBe('https://dev.abdm.gov.in')
  })
})

describe('NHCX config', () => {
  it('NHCX needs ABDM and its own keys', () => {
    expect(readNhcxConfig({ ...FULL_NHCX, ABDM_CLIENT_ID: undefined }).state).toBe('not_configured')
    expect(readNhcxConfig(FULL_NHCX)).toMatchObject({ state: 'configured', config: { participantCode: '1000099@sbx', maxAttachmentBytes: 10_000_000 } })
  })
  it('decodes the PEMs, parses the allowlist and the attachment cap', () => {
    const r = readNhcxConfig({ ...FULL_NHCX, NHCX_CALLBACK_IP_ALLOWLIST: '10.0.0.1, 10.0.0.2,not-an-ip', NHCX_MAX_ATTACHMENT_BYTES: '5000000' })
    if (r.state !== 'configured') throw new Error('expected configured')
    expect(r.config.encryptionPrivateKeyPem).toContain('-----BEGIN PRIVATE KEY-----')
    expect(r.config.callbackIpAllowlist).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(r.config.maxAttachmentBytes).toBe(5_000_000)
    expect(r.config.previousEncryptionPrivateKeyPem).toBeNull()
    expect(r.config.gatewaySigningCertPem).toBeNull()
  })
  it('a junk PEM counts as missing, by name only', () => {
    const r = readNhcxConfig({ ...FULL_NHCX, NHCX_ENCRYPTION_CERT: b64('hello') })
    expect(r).toEqual({ state: 'not_configured', missing: ['NHCX_ENCRYPTION_CERT'] })
  })
  it('missing ABDM is named for NHCX', () => {
    const r = readNhcxConfig({ ...FULL_NHCX, ABDM_CM_ID: undefined })
    expect(r).toEqual({ state: 'not_configured', missing: ['ABDM_CM_ID'] })
  })
  it('the mock applies to NHCX too', () => {
    expect(readNhcxConfig({ ABDM_USE_MOCKS: '1', NODE_ENV: 'development' })).toEqual({ state: 'mock' })
  })
})

describe('capability statuses', () => {
  it('capability statuses', () => {
    const s = capabilityStatuses({ ...FULL_ABDM })
    expect(s.find((c) => c.key === 'abha')!.state).toBe('configured')
    expect(s.find((c) => c.key === 'scan_share')!.missing).toEqual(['ABDM_HIP_ID', 'ABDM_GATEWAY_JWKS_URL'])
    expect(s.find((c) => c.key === 'nhcx_submit')!.label).toBe('Not configured')
  })
  it('all five keys, mock labels, never a value', () => {
    const s = capabilityStatuses({ ABDM_USE_MOCKS: '1', NODE_ENV: 'development', ABDM_CLIENT_SECRET: 'super-secret' })
    expect(s.map((c) => c.key)).toEqual(['abha', 'scan_share', 'nhcx_submit', 'nhcx_callbacks', 'nhcx_eligibility'])
    expect(s.every((c) => c.state === 'mock' && c.label === 'Sandbox mock - not real')).toBe(true)
    expect(JSON.stringify(s)).not.toContain('super-secret')
  })
  it('callbacks need the gateway signing certificate', () => {
    const s = capabilityStatuses(FULL_NHCX)
    expect(s.find((c) => c.key === 'nhcx_submit')!.state).toBe('configured')
    expect(s.find((c) => c.key === 'nhcx_callbacks')).toMatchObject({ state: 'not_configured', missing: ['NHCX_GATEWAY_SIGNING_CERT'] })
    expect(s.find((c) => c.key === 'abha')!.label).toBe('Connected')
  })
})
