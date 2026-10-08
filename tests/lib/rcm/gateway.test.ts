import { describe, it, expect } from 'vitest'
import { getClaimGateway, nhcxGatewayStub, type SubmissionPackage } from '@/lib/rcm/gateway'

const PKG = { claimNumber: 'CLM-2099-000001', version: 1, kind: 'initial', snapshot: {} as never, insurerCopySha256: 'a'.repeat(64), trackingReference: null } satisfies SubmissionPackage

describe('ClaimGateway', () => {
  it('manual channels record the tracking reference', async () => {
    const g = getClaimGateway('portal'); expect(g.status().configured).toBe(true); expect(g.status().label).toBe('Recorded manually (Insurer/TPA portal)')
    expect(await g.submit({ ...PKG, trackingReference: 'TPA/77' })).toEqual({ ok: true, transport: 'manual', trackingReference: 'TPA/77' })
  })
  it('NHCX is not configured and never fakes a submission', async () => {
    expect(getClaimGateway('nhcx').status()).toEqual({ configured: false, label: 'NHCX not connected (planned)' })
    expect(await getClaimGateway('nhcx').submit(PKG)).toMatchObject({ ok: false, error: 'not_configured' })
  })
  it('a registry adapter replaces the stub', () => { const fake = { ...nhcxGatewayStub, status: () => ({ configured: true, label: 'x' }) }; expect(getClaimGateway('nhcx', { nhcx: fake })).toBe(fake) })
})
