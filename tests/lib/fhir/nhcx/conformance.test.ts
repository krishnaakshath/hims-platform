import { describe, it, expect } from 'vitest'
import { buildClaimBundle, buildPreauthBundle } from '@/lib/fhir/nhcx/claim'
import { buildEligibilityBundle } from '@/lib/fhir/nhcx/eligibility'
import { buildCommunicationResponseTaskBundle, buildPaymentAckTaskBundle, buildStatusTaskBundle } from '@/lib/fhir/nhcx/responses'
import { validateNhcxBundle, type BundleProfile } from '@/lib/fhir/nhcx/validate'
import { PROFILE } from '@/lib/fhir/nhcx/systems'
import type { ClaimSnapshot, PreauthSnapshot } from '@/lib/rcm/snapshot'
import { CTX, HOSPITAL, INSURER, POLICY, PRE, SNAP, TPA, fixture, type AnyJson } from './fixtures'

// SP8 conformance sweep: every builder, over a matrix of SP7 snapshots, yields a
// bundle the structural validator accepts, with no national ID, contact or
// address data, INR money with at most two decimals, and the S5 profile.

const doc = (kind: ClaimSnapshot['documents'][number]['kind'], i: number) => ({ kind, source: 'upload' as const, title: `Doc ${i}`, contentType: 'application/pdf', sha256: String(i).repeat(64).slice(0, 64), waived: false })
const claimMatrix: [string, ClaimSnapshot][] = []
for (const claimType of ['ipd', 'daycare', 'opd'] as const) {
  for (const abha of [null, '91-1234-5678-9012']) {
    for (const docs of [0, 1, 3]) {
      claimMatrix.push([`${claimType} abha=${Boolean(abha)} docs=${docs}`, {
        ...SNAP, claim: { ...SNAP.claim, claimType }, patient: { ...SNAP.patient, abhaNumber: abha },
        documents: [doc('discharge_summary', 1), doc('itemised_bill', 2), doc('investigation_reports', 3)].slice(0, docs),
      }])
    }
  }
}
claimMatrix.push(['no TPA', { ...SNAP, policy: { ...POLICY, tpa: null } }])
claimMatrix.push(['amounts above 2^31 paise', { ...SNAP, items: SNAP.items.map((i) => ({ ...i, unitPricePaise: 3_000_000_007, totalPaise: 3_000_000_007 })), totals: { billedPaise: 6_000_000_014, claimedPaise: 6_000_000_014 } }])
const preMatrix: [string, PreauthSnapshot][] = [['initial', PRE], ['enhancement', { ...PRE, kind: 'enhancement' }], ['with ABHA', { ...PRE, patient: { ...PRE.patient, abhaNumber: '91-1234-5678-9012' } }]]

function moneyNodes(v: unknown, out: AnyJson[] = []): AnyJson[] {
  if (Array.isArray(v)) v.forEach((x) => moneyNodes(x, out))
  else if (v && typeof v === 'object') {
    const o = v as AnyJson
    if ('currency' in o && 'value' in o) out.push(o)
    Object.values(o).forEach((x) => moneyNodes(x, out))
  }
  return out
}
function check(b: AnyJson, profile: BundleProfile, canonical: string) {
  expect(validateNhcxBundle(b, profile)).toEqual([])
  const text = JSON.stringify(b).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
  expect(text).not.toMatch(/uidai|"ADN"|telecom|"address"|\b\d{12}\b/)
  for (const m of moneyNodes(b)) { expect(m.currency).toBe('INR'); expect(String(m.value)).toMatch(/^\d+(\.\d{1,2})?$/) }
  expect(b.meta.profile[0]).toBe(canonical)
}

describe('NHCX conformance matrix', () => {
  it.each(claimMatrix)('claim bundle: %s', (_n, s) => check(buildClaimBundle(s, CTX), 'ClaimBundle', PROFILE.ClaimBundle))
  it.each(preMatrix)('pre-auth bundle: %s', (_n, s) => check(buildPreauthBundle(s, { ...CTX, priorPreauthRef: 'PA-1' }), 'ClaimBundle', PROFILE.ClaimBundle))
  it('eligibility, communication reply, payment acknowledgement and status bundles', () => {
    check(buildEligibilityBundle({ requestId: crypto.randomUUID(), purpose: 'validation', created: new Date(), patient: SNAP.patient, hospital: HOSPITAL, insurer: INSURER, policy: POLICY, practitioner: CTX.practitioner, serviceDate: '2026-10-08' }), 'CoverageEligibilityRequestBundle', PROFILE.CoverageEligibilityRequestBundle)
    check(buildCommunicationResponseTaskBundle({ request: { identifier: 'Q1', fullBundle: fixture('Bundle-TaskBundleForCommunicationRequest-example-01') }, text: 'Attached', attachments: [], created: new Date(), hospital: HOSPITAL, payer: TPA }), 'TaskBundle', PROFILE.TaskBundle)
    check(buildPaymentAckTaskBundle({ created: new Date(), hospital: HOSPITAL, payer: TPA }), 'TaskBundle', PROFILE.TaskBundle)
    check(buildStatusTaskBundle({ created: new Date(), sender: 'P1@sbx', recipient: 'TPA1@sbx', correlationId: crypto.randomUUID() }), 'TaskBundle', PROFILE.TaskBundle)
  })
})
