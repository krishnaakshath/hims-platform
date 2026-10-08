// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { hasOpenssl, makeTestKeyPairAndCert } from '../helpers/selfsigned'
import { integrationOverview } from '@/lib/integrations/overview'

const OPENSSL = hasOpenssl()
const ENC = OPENSSL ? makeTestKeyPairAndCert('P1@sbx', 400) : null
const SIGN = OPENSSL ? makeTestKeyPairAndCert('nhcx-gateway', 20) : null
const b64 = (s: string) => Buffer.from(s).toString('base64')
const ENV = () => ({
  ABDM_GATEWAY_BASE_URL: 'https://dev.abdm.gov.in', ABHA_BASE_URL: 'https://abhasbx.abdm.gov.in', ABDM_CLIENT_ID: 'cid-value', ABDM_CLIENT_SECRET: 'S3CRET-VALUE', ABDM_CM_ID: 'sbx',
  NHCX_API_BASE_URL: 'https://apisbx.abdm.gov.in/hcx', NHCX_PARTICIPANT_SERVICE_URL: 'https://apisbx.abdm.gov.in/hcx/p', NHCX_PARTICIPANT_CODE: '1000099@sbx',
  NHCX_ENCRYPTION_PRIVATE_KEY: b64(ENC!.privateKeyPem), NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY: b64(ENC!.privateKeyPem), NHCX_ENCRYPTION_CERT: b64(ENC!.certPem),
  NHCX_GATEWAY_SIGNING_CERT: b64(SIGN!.certPem), INTEGRATION_PAYLOAD_KEY: b64('k'.repeat(32)), NEXT_PUBLIC_APP_URL: 'https://hims.example',
})

async function renderPage(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Admin', userId: 1 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }), useRouter: () => ({ refresh: vi.fn() }) }))
  vi.doMock('@/lib/queries/nhcx-review', () => ({ recentExchanges: vi.fn(async () => [{ id: 4, action: 'claim/submit', direction: 'outbound', state: 'sent', createdAt: '2026-10-08T06:00:00.000Z', isMock: false }]) }))
  const { default: Page } = await import('@/app/(dashboard)/settings/integrations/page')
  return renderToStaticMarkup(await Page())
}

afterEach(() => vi.unstubAllEnvs())

describe.skipIf(!OPENSSL)('/settings/integrations', () => {
  it('shows states, missing names and certificate expiry, and never a secret', async () => {
    const env = ENV()
    const html = await renderPage(env)
    expect(html).not.toMatch(/S3CRET-VALUE|BEGIN|PRIVATE KEY|cid-value/)
    expect(html).not.toContain(env.NHCX_ENCRYPTION_PRIVATE_KEY.slice(0, 40))
    expect(html).toMatch(/days left/)
    expect(html).toContain('1000099@sbx'); expect(html).toContain('https://hims.example/api/nhcx/callback'); expect(html).toContain('https://hims.example/api/abdm')
    expect(html).toContain('Rotation in progress'); expect(html).toContain('Mode: Sandbox')
    expect(html).toContain('Missing: <span class="font-mono">ABDM_HIP_ID, ABDM_GATEWAY_JWKS_URL</span>')
  })
  it('warns 30 days before certificate expiry', () => {
    const o = integrationOverview(ENV())
    expect(o.signingCert!.warning).toBe('expiring'); expect(o.encryptionCert!.warning).toBe('none')
    const later = integrationOverview(ENV(), new Date(Date.now() + 25 * 86_400_000))
    expect(later.signingCert!.warning).toBe('expired')
  })
})
