import { fhirSystemFor, isSampleVersion } from '@/lib/coding/code-systems'
import { istIsoWithOffset } from '@/lib/nhcx/headers'
import type { ClaimSnapshot, CodedEntry, PreauthSnapshot, SnapshotHospital, SnapshotPatient, SnapshotPolicy } from '@/lib/rcm/snapshot'
import type { ClaimType } from '@/lib/rcm/constants'
import { paiseToFhirMoney } from './money'
import { nhcxCoverage, nhcxHospital, nhcxPatient, nhcxPayer, nhcxPractitioner, type NhcxBuildErrorCode } from './resources'
import {
  CLAIM_TYPE_CODING, CS_IDENTIFIER_TYPE, CS_SUPPORTINGINFO_CATEGORY, CS_SUPPORTINGINFO_CODE, DIAGNOSIS_TYPE_CODING, DOCUMENT_KIND_SUPPORTING_INFO,
  PROCESS_PRIORITY, PROFILE, SNOMED, localSystem, type FhirCoding,
} from './systems'
import { entry, newId, ref, type FhirBundle, type FhirResource } from './types'

// Claim (use claim) and pre-authorisation (use preauthorization) bundles from
// the SP7 immutable snapshots (S5 6.5.0 ClaimBundle). Item net is the
// GST-inclusive line total and unitPrice the pre-tax unit price (ruling 9).
// `related` is not set on claim bundles: the resubmission relationship code is
// UNVERIFIED (U15); query responses go out as Communication TaskBundles.

export interface ClaimBundleContext {
  created: Date
  practitioner: { name: string; registrationNumber: string | null }
  /** sha256 -> attachment bytes; when absent a supporting document carries its title only. */
  attachments?: Map<string, { contentType: string; dataBase64: string }>
  priorPreauthRef?: string | null
}

const isPreauth = (s: ClaimSnapshot | PreauthSnapshot): s is PreauthSnapshot => 'preauthNumber' in s

function coding(c: CodedEntry): FhirCoding {
  const system = fhirSystemFor({ kind: c.kind, version: c.version ?? '', isSample: c.version ? isSampleVersion(c.version) : false })
  const out: FhirCoding = { system: system ?? '', code: c.code, display: c.display }
  if (c.version) out.version = c.version
  return out
}

/** The pre-send gate, in order; empty means the bundle may be built (then validated). */
export function claimBundleProblems(s: ClaimSnapshot | PreauthSnapshot, ctx: ClaimBundleContext): NhcxBuildErrorCode[] {
  const out: NhcxBuildErrorCode[] = []
  const pre = isPreauth(s)
  const items = pre ? s.estimate.length : s.items.length
  if (items === 0) out.push('no_items')
  if (s.diagnoses.length === 0) out.push('no_diagnosis')
  const coded: CodedEntry[] = [...s.diagnoses, ...s.procedures]
  if (coded.some((c) => c.version != null && isSampleVersion(c.version))) out.push('sample_codes')
  else if (s.procedures.some((p) => fhirSystemFor({ kind: p.kind, version: p.version ?? '', isSample: false }) === null)) out.push('unmapped_procedure_codes')
  if (!ctx.practitioner.registrationNumber) out.push('practitioner_registration_missing')
  if (!s.hospital.hfrId && !s.hospital.rohiniId) out.push('hospital_ids_missing')
  if (!s.patient.uhid) out.push('patient_uhid_missing')
  return out
}

interface Core {
  use: 'claim' | 'preauthorization'
  identifier: string
  claimType: ClaimType
  hospital: SnapshotHospital
  patient: SnapshotPatient
  policy: SnapshotPolicy
  billablePeriod: { start: string; end?: string }
  diagnosis: (ids: { claim: string }) => unknown[]
  procedure: unknown[]
  item: unknown[]
  totalPaise: number
  supportingInfo: unknown[]
  preAuthRef: string | null
  related?: unknown[]
}

function bundleFor(c: Core, ctx: ClaimBundleContext): FhirBundle {
  const ids = { claim: newId(), patient: newId(), insurer: newId(), hospital: newId(), practitioner: newId(), coverage: newId() }
  const created = istIsoWithOffset(ctx.created)
  const claim: FhirResource = {
    resourceType: 'Claim', id: ids.claim, meta: { profile: [PROFILE.Claim] },
    identifier: [{ type: { coding: [{ system: CS_IDENTIFIER_TYPE, code: 'CLN', display: 'Claim number' }] }, system: localSystem('claim-number'), value: c.identifier }],
    status: 'active',
    type: { coding: [CLAIM_TYPE_CODING[c.claimType]] },
    use: c.use,
    patient: ref(ids.patient),
    billablePeriod: c.billablePeriod,
    created,
    insurer: ref(ids.insurer),
    provider: ref(ids.hospital),
    priority: { coding: [{ system: PROCESS_PRIORITY, code: 'normal' }] },
    careTeam: [{
      sequence: 1, provider: ref(ids.practitioner),
      role: { coding: [{ system: SNOMED, code: '223366009', display: 'Healthcare professional (occupation)' }] },
      qualification: { coding: [{ system: SNOMED, code: '394658006', display: 'Clinical specialty (qualifier value)' }] },
    }],
    diagnosis: c.diagnosis(ids),
    insurance: [{ sequence: 1, focal: true, coverage: ref(ids.coverage), ...(c.preAuthRef ? { preAuthRef: [c.preAuthRef] } : {}) }],
    item: c.item,
    total: paiseToFhirMoney(c.totalPaise),
  }
  if (c.procedure.length > 0) claim.procedure = c.procedure
  if (c.supportingInfo.length > 0) claim.supportingInfo = c.supportingInfo
  if (c.related) claim.related = c.related
  return {
    resourceType: 'Bundle', id: newId(), meta: { profile: [PROFILE.ClaimBundle] }, identifier: { value: newId() }, type: 'collection', timestamp: created,
    entry: [
      entry(claim),
      entry(nhcxPatient(c.patient, ids.patient)),
      entry(nhcxPayer(c.policy.insurer, ids.insurer)),
      entry(nhcxHospital(c.hospital, ids.hospital)),
      entry(nhcxPractitioner(ctx.practitioner, ids.practitioner)),
      entry(nhcxCoverage(c.policy, ids.coverage, { patientId: ids.patient, insurerId: ids.insurer })),
    ],
  }
}

const itemOf = (sequence: number, code: string, name: string, quantity: number, unitPricePaise: number, netPaise: number, servicedDate?: string) => ({
  sequence, careTeamSequence: [1],
  productOrService: { coding: [{ system: localSystem('service-code'), code, display: name }] },
  ...(servicedDate ? { servicedDate } : {}),
  quantity: { value: quantity },
  unitPrice: paiseToFhirMoney(unitPricePaise),
  net: paiseToFhirMoney(netPaise),
})

export function buildClaimBundle(s: ClaimSnapshot, ctx: ClaimBundleContext): FhirBundle {
  const docs = s.documents.filter((d) => !d.waived)
  return bundleFor({
    use: 'claim',
    identifier: `${s.claim.claimNumber}/v${s.claim.version}`,
    claimType: s.claim.claimType,
    hospital: s.hospital, patient: s.patient, policy: s.policy,
    billablePeriod: { start: s.episode.startDate, ...(s.episode.endDate ? { end: s.episode.endDate } : {}) },
    diagnosis: () => s.diagnoses.map((d, i) => ({ sequence: i + 1, diagnosisCodeableConcept: { coding: [coding(d)] }, type: [{ coding: [DIAGNOSIS_TYPE_CODING[d.type]] }] })),
    procedure: s.procedures.map((p, i) => ({ sequence: i + 1, date: p.performedOn, procedureCodeableConcept: { coding: [coding(p)] } })),
    item: s.items.map((it) => itemOf(it.sequence, it.itemCode, it.itemName, it.quantity, it.unitPricePaise, it.totalPaise, it.serviceDate)),
    totalPaise: s.totals.claimedPaise,
    supportingInfo: docs.map((d, i) => {
      const si = DOCUMENT_KIND_SUPPORTING_INFO[d.kind]
      const att = d.sha256 ? ctx.attachments?.get(d.sha256) : undefined
      const valueAttachment: Record<string, string> = { title: d.title }
      const contentType = att?.contentType ?? d.contentType
      if (contentType) valueAttachment.contentType = contentType
      if (att) valueAttachment.data = att.dataBase64
      return {
        sequence: i + 1,
        category: { coding: [{ system: CS_SUPPORTINGINFO_CATEGORY, code: si.category }] },
        code: { coding: [{ system: CS_SUPPORTINGINFO_CODE, code: si.code }] },
        valueAttachment,
      }
    }),
    preAuthRef: s.preauth?.approvalReference ?? null,
  }, ctx)
}

export function buildPreauthBundle(s: PreauthSnapshot, ctx: ClaimBundleContext): FhirBundle {
  const enhancement = s.kind === 'enhancement'
  return bundleFor({
    use: 'preauthorization',
    identifier: s.preauthNumber,
    claimType: s.claimType,
    hospital: s.hospital, patient: s.patient, policy: s.policy,
    billablePeriod: { start: s.plannedAdmissionDate },
    diagnosis: () => s.diagnoses.map((d, i) => ({ sequence: i + 1, diagnosisCodeableConcept: { coding: [coding(d)] }, type: [{ coding: [DIAGNOSIS_TYPE_CODING.provisional] }] })),
    procedure: s.procedures.map((p, i) => ({ sequence: i + 1, procedureCodeableConcept: { coding: [coding(p)] } })),
    item: s.estimate.map((l, i) => itemOf(i + 1, l.code, l.name, l.quantity, l.unitPricePaise, l.amountPaise)),
    totalPaise: s.requestedPaise,
    supportingInfo: [],
    preAuthRef: enhancement ? ctx.priorPreauthRef ?? null : null,
    related: enhancement ? [{ relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship', code: 'prior', display: 'Prior Claim' }] } }] : undefined,
  }, ctx)
}
