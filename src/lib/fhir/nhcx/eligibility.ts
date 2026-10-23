import type { EligibilityPurpose, NhcxCoverageLimits, NhcxResponseSummary } from '@/lib/nhcx/constants'
import { istIsoWithOffset } from '@/lib/nhcx/headers'
import type { PayerRef, SnapshotHospital, SnapshotPatient, SnapshotPolicy } from '@/lib/rcm/snapshot'
import { nhcxCoverage, nhcxHospital, nhcxLocation, nhcxPatient, nhcxPayer, nhcxPractitioner } from './resources'
import { fhirMoneyToPaise } from './money'
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
    errorCodes: [], adjudicationReasonCodes: [], paymentAmountPaise: null, paymentDate: null, hasQueryText: false, coverage: null,
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

/** Longest insurer reference kept (coverage_verifications.insurer_reference, R6). */
export const INSURER_REFERENCE_MAX = 64

// WS12 R6. The item category codes `room-rent` / `icu` and the benefit type codes `benefit` /
// `copay-percent` are UNVERIFIED (docs/ABDM-NHCX.md U21) against the NRCeS profile; they are
// matched by code whatever the system, so a corrected system needs no change here.
const ROOM_RENT_CATEGORY = 'room-rent'
const ICU_CATEGORY = 'icu'
const BENEFIT_TYPE = 'benefit'
const COPAY_PERCENT_TYPE = 'copay-percent'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const codesIn = (cc: unknown): string[] => (isObj(cc) && Array.isArray(cc.coding) ? cc.coding.filter(isObj).map((c) => c.code).filter((c): c is string => typeof c === 'string') : [])
const listOf = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : [])

/** Limits from CoverageEligibilityResponse.insurance[0] (R6), or null when it reports none. */
function coverageLimitsOf(ins: Json | null): NhcxCoverageLimits | null {
  if (!ins) return null
  const out: NhcxCoverageLimits = { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null, benefitPeriodEnd: null }
  const end = isObj(ins.benefitPeriod) ? ins.benefitPeriod.end : null
  if (typeof end === 'string' && ISO_DATE.test(end.slice(0, 10)) && (end.length === 10 || end[10] === 'T')) out.benefitPeriodEnd = end.slice(0, 10)
  for (const item of listOf(ins.item)) {
    const category = codesIn(item.category)
    const benefits = listOf(item.benefit)
    const perDay = category.includes(ROOM_RENT_CATEGORY) ? 'roomRentLimitPaise' : category.includes(ICU_CATEGORY) ? 'icuLimitPaise' : null
    if (perDay) {
      if (out[perDay] === null) out[perDay] = benefits.map((b) => fhirMoneyToPaise(b.allowedMoney)).find((p) => p !== null) ?? null
      continue
    }
    for (const b of benefits) {
      const types = codesIn(b.type)
      if (types.includes(BENEFIT_TYPE) && out.sumInsuredPaise === null) {
        const allowed = fhirMoneyToPaise(b.allowedMoney)
        if (allowed === null) continue
        out.sumInsuredPaise = allowed
        const used = b.usedMoney === undefined ? null : fhirMoneyToPaise(b.usedMoney)
        out.balancePaise = used === null ? null : Math.max(0, allowed - used)
      } else if (types.includes(COPAY_PERCENT_TYPE) && out.copayBp === null) {
        const pct = b.allowedUnsignedInt
        if (typeof pct === 'number' && Number.isInteger(pct) && pct >= 0 && pct <= 100) out.copayBp = pct * 100
      }
    }
  }
  return Object.values(out).some((v) => v !== null) ? out : null
}

export function parseEligibilityResponse(bundle: unknown):
  | { ok: true; summary: NhcxResponseSummary; requestIdentifier: string | null; insurerReference: string | null }
  | { ok: false; problem: string } {
  const resources = bundleResources(bundle)
  const resp = resources.find((r) => r.resourceType === 'CoverageEligibilityResponse')
  if (!resp) return { ok: false, problem: 'No CoverageEligibilityResponse in the bundle' }
  const ins = Array.isArray(resp.insurance) && isObj(resp.insurance[0]) ? resp.insurance[0] : null
  const req = resources.find((r) => r.resourceType === 'CoverageEligibilityRequest')
  const reqId = req && Array.isArray(req.identifier) && isObj(req.identifier[0]) && typeof req.identifier[0].value === 'string' ? req.identifier[0].value : null
  // R6: the insurer's reference is returned beside the summary (stored, never logged), not in it.
  const ref = Array.isArray(resp.identifier) && isObj(resp.identifier[0]) && typeof resp.identifier[0].value === 'string' ? resp.identifier[0].value.trim() : ''
  return {
    ok: true,
    summary: { ...emptySummary(), outcome: outcomeOf(resp.outcome), inforce: ins && typeof ins.inforce === 'boolean' ? ins.inforce : null, errorCodes: errorCodesOf(resp), coverage: coverageLimitsOf(ins) },
    requestIdentifier: reqId,
    insurerReference: ref ? ref.slice(0, INSURER_REFERENCE_MAX) : null,
  }
}
