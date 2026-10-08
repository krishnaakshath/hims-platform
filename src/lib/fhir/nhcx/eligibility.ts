import type { EligibilityPurpose, NhcxResponseSummary } from '@/lib/nhcx/constants'
import { istIsoWithOffset } from '@/lib/nhcx/headers'
import type { PayerRef, SnapshotHospital, SnapshotPatient, SnapshotPolicy } from '@/lib/rcm/snapshot'
import { nhcxCoverage, nhcxHospital, nhcxLocation, nhcxPatient, nhcxPayer, nhcxPractitioner } from './resources'
import { PROCESS_PRIORITY, PROFILE, localSystem } from './systems'
import { entry, newId, ref, type FhirBundle, type FhirResource } from './types'

// CoverageEligibilityRequest bundle and response parser (S5 6.5.0
// CoverageEligibilityRequestBundle / ResponseBundle). Entry order follows the
// official examples.

export interface EligibilityInput {
  requestId: string
  purpose: EligibilityPurpose
  created: Date
  patient: SnapshotPatient
  hospital: SnapshotHospital
  insurer: PayerRef
  policy: SnapshotPolicy
  practitioner: { name: string; registrationNumber: string | null }
  serviceDate: string
}

export function buildEligibilityBundle(i: EligibilityInput): FhirBundle {
  const ids = { req: newId(), patient: newId(), practitioner: newId(), insurer: newId(), hospital: newId(), location: newId(), coverage: newId() }
  const created = istIsoWithOffset(i.created)
  const request: FhirResource = {
    resourceType: 'CoverageEligibilityRequest', id: ids.req, meta: { profile: [PROFILE.CoverageEligibilityRequest] },
    identifier: [{ system: localSystem('eligibility'), value: i.requestId }],
    status: 'active',
    priority: { coding: [{ system: PROCESS_PRIORITY, code: 'normal' }] },
    purpose: [i.purpose],
    patient: ref(ids.patient),
    servicedDate: i.serviceDate,
    created,
    enterer: ref(ids.practitioner),
    provider: ref(ids.practitioner),
    insurer: ref(ids.insurer),
    facility: ref(ids.location),
    insurance: [{ focal: true, coverage: ref(ids.coverage) }],
  }
  return {
    resourceType: 'Bundle', id: i.requestId, meta: { profile: [PROFILE.CoverageEligibilityRequestBundle] }, identifier: { value: i.requestId },
    type: 'collection', timestamp: created,
    entry: [
      entry(request),
      entry(nhcxPatient(i.patient, ids.patient)),
      entry(nhcxPractitioner(i.practitioner, ids.practitioner)),
      entry(nhcxPayer(i.insurer, ids.insurer)),
      entry(nhcxHospital(i.hospital, ids.hospital)),
      entry(nhcxLocation(i.hospital, ids.location, ids.hospital)),
      entry(nhcxCoverage(i.policy, ids.coverage, { patientId: ids.patient, insurerId: ids.insurer })),
    ],
  }
}

export function emptySummary(): NhcxResponseSummary {
  return {
    outcome: null, use: null, submittedPaise: null, benefitPaise: null, preAuthRefPresent: false, inforce: null,
    errorCodes: [], adjudicationReasonCodes: [], paymentAmountPaise: null, paymentDate: null, hasQueryText: false,
  }
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export function bundleResources(bundle: unknown): Json[] {
  if (!isObj(bundle) || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) return []
  return bundle.entry.map((e) => (isObj(e) && isObj(e.resource) ? e.resource : null)).filter((r): r is Json => r !== null)
}

export function outcomeOf(v: unknown): NhcxResponseSummary['outcome'] {
  return v === 'queued' || v === 'complete' || v === 'partial' || v === 'error' ? v : null
}

const CODE = /^[A-Za-z0-9._-]{1,64}$/
export function errorCodesOf(r: Json): string[] {
  const out: string[] = []
  for (const e of Array.isArray(r.error) ? r.error : []) {
    const coding = isObj(e) && isObj(e.code) && Array.isArray(e.code.coding) ? e.code.coding : []
    for (const c of coding) if (isObj(c) && typeof c.code === 'string' && CODE.test(c.code)) out.push(c.code)
  }
  return out
}

export function parseEligibilityResponse(bundle: unknown): { ok: true; summary: NhcxResponseSummary; requestIdentifier: string | null } | { ok: false; problem: string } {
  const resources = bundleResources(bundle)
  const resp = resources.find((r) => r.resourceType === 'CoverageEligibilityResponse')
  if (!resp) return { ok: false, problem: 'No CoverageEligibilityResponse in the bundle' }
  const ins = Array.isArray(resp.insurance) && isObj(resp.insurance[0]) ? resp.insurance[0] : null
  const req = resources.find((r) => r.resourceType === 'CoverageEligibilityRequest')
  const reqId = req && Array.isArray(req.identifier) && isObj(req.identifier[0]) && typeof req.identifier[0].value === 'string' ? req.identifier[0].value : null
  return {
    ok: true,
    summary: { ...emptySummary(), outcome: outcomeOf(resp.outcome), inforce: ins && typeof ins.inforce === 'boolean' ? ins.inforce : null, errorCodes: errorCodesOf(resp) },
    requestIdentifier: reqId,
  }
}
