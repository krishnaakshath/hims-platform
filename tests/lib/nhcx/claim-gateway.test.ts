import { describe, it, expect, vi, afterEach } from 'vitest'
import { nhcxClaimGateway, recipientCodeFor, resolveNhcxClaimGateway } from '@/lib/nhcx/claim-gateway'
import { getClaimGateway, nhcxGatewayStub, type SubmissionPackage } from '@/lib/rcm/gateway'
import { INSURER, POLICY, SNAP, TPA } from '../fhir/nhcx/fixtures'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PKG: SubmissionPackage = { claimNumber: SNAP.claim.claimNumber, version: 1, kind: 'initial', snapshot: SNAP, insurerCopySha256: 'c'.repeat(64), trackingReference: null }
const gw = nhcxClaimGateway({ mode: 'configured' })
afterEach(() => vi.restoreAllMocks())

describe('NhcxClaimGateway', () => {
  it('not configured resolves to the SP7 stub; mock and real resolve to the gateway', () => {
    expect(resolveNhcxClaimGateway({})).toBe(nhcxGatewayStub)
    expect(resolveNhcxClaimGateway({ ABDM_USE_MOCKS: '1', NODE_ENV: 'development' }).status()).toEqual({ configured: true, label: 'NHCX sandbox mock - not real' })
    expect(gw.status()).toEqual({ configured: true, label: 'NHCX connected' })
  })
  it('submit validates and returns a correlation id without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch'); const r = await gw.submit(PKG)
    expect(r).toMatchObject({ ok: true, transport: 'nhcx', trackingReference: expect.stringMatching(UUID) }); expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('a payer without a participant code is rejected with the copy', async () => {
    const snapshot = { ...SNAP, policy: { ...POLICY, tpa: null, insurer: { ...INSURER, nhcxParticipantCode: null } } }
    expect(await gw.submit({ ...PKG, snapshot })).toEqual({ ok: false, error: 'rejected', message: 'This insurer or TPA has no NHCX participant code' })
  })
  it('NHCX refusal leaves the manual channel usable', async () => {
    const sample = { ...PKG, snapshot: { ...SNAP, diagnoses: [{ ...SNAP.diagnoses[0], version: 'SAMPLE-ICD10-0' }] } }
    expect(await gw.submit(sample)).toMatchObject({ ok: false, error: 'rejected', message: expect.stringMatching(/Sample code sets/) })
    expect(await getClaimGateway('portal').submit(sample)).toEqual({ ok: true, transport: 'manual', trackingReference: null })
  })
  it('a doctor without a registration number is refused', async () => {
    const snapshot = { ...SNAP, episode: { ...SNAP.episode, attendingRegistration: null } }
    expect(await gw.submit({ ...PKG, snapshot })).toMatchObject({ ok: false, message: 'The treating doctor has no registration number' })
  })
  it('the recipient is the TPA when it has a code', () => {
    expect(recipientCodeFor({ insurer: INSURER, tpa: TPA })).toBe('TPA1@sbx')
    expect(recipientCodeFor({ insurer: INSURER, tpa: { ...TPA, nhcxParticipantCode: null } })).toBe('INS1@sbx')
    expect(recipientCodeFor({ insurer: { ...INSURER, nhcxParticipantCode: null }, tpa: null })).toBeNull()
  })
})
