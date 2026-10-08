// Writes the SP8 NHCX conformance-matrix bundles to a directory for the
// optional HL7 validator step (docs/ABDM-NHCX.md). Test fixtures only; no
// patient data. Usage: npx tsx scripts/nhcx-dump-fixtures.ts out
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildClaimBundle, buildPreauthBundle } from '../src/lib/fhir/nhcx/claim'
import { buildEligibilityBundle } from '../src/lib/fhir/nhcx/eligibility'
import { buildPaymentAckTaskBundle } from '../src/lib/fhir/nhcx/responses'
import { CTX, HOSPITAL, INSURER, POLICY, PRE, SNAP, TPA } from '../tests/lib/fhir/nhcx/fixtures'

const out = process.argv[2] ?? 'out'
mkdirSync(out, { recursive: true })
const bundles: Record<string, unknown> = {
  'claim-ipd': buildClaimBundle(SNAP, CTX),
  'claim-opd-abha': buildClaimBundle({ ...SNAP, claim: { ...SNAP.claim, claimType: 'opd' }, patient: { ...SNAP.patient, abhaNumber: '91-0000-0000-0001' } }, CTX),
  'preauth-initial': buildPreauthBundle(PRE, CTX),
  'preauth-enhancement': buildPreauthBundle({ ...PRE, kind: 'enhancement' }, { ...CTX, priorPreauthRef: 'PA-1' }),
  eligibility: buildEligibilityBundle({ requestId: crypto.randomUUID(), purpose: 'validation', created: new Date(), patient: SNAP.patient, hospital: HOSPITAL, insurer: INSURER, policy: POLICY, practitioner: CTX.practitioner, serviceDate: new Date().toISOString().slice(0, 10) }),
  'payment-ack': buildPaymentAckTaskBundle({ created: new Date(), hospital: HOSPITAL, payer: TPA }),
}
for (const [name, b] of Object.entries(bundles)) writeFileSync(path.join(out, `${name}.json`), JSON.stringify(b, null, 2))
process.stdout.write(`wrote ${Object.keys(bundles).length} bundles to ${out}\n`)
