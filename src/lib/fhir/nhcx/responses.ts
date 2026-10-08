import type { NhcxResponseSummary } from '@/lib/nhcx/constants'
import { istIsoWithOffset } from '@/lib/nhcx/headers'
import type { PayerRef, SnapshotHospital } from '@/lib/rcm/snapshot'
import { bundleResources, emptySummary, errorCodesOf, outcomeOf } from './eligibility'
import { fhirMoneyToPaise } from './money'
import { nhcxHospital, nhcxPayer } from './resources'
import { ADJUDICATION, COMM_CATEGORY, CS_ADJUDICATION_REASON, CS_TASK_CODES, CS_TASK_OUTPUT_TYPE, CS_TASK_OUTPUT_VALUE, FINANCIAL_TASK_CODE, FINANCIAL_TASK_INPUT, PROFILE } from './systems'
import { entry, newId, ref, type FhirBundle, type FhirBundleEntry, type FhirResource } from './types'

// Insurer responses (S5 6.5.0 ClaimResponseBundle, TaskBundle for
// CommunicationRequest and PaymentNotice) and the provider's replies. Parsers
// put only codes, amounts and flags into the summary; free text (disposition,
// query text) and references are returned separately, for the encrypted
// payload view only.

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const firstIdentifier = (r: Json | undefined): string | null =>
  r && Array.isArray(r.identifier) && isObj(r.identifier[0]) && typeof r.identifier[0].value === 'string' ? r.identifier[0].value : null
const codesOf = (cc: unknown): Json[] => (isObj(cc) && Array.isArray(cc.coding) ? cc.coding.filter(isObj) : [])

function byReference(bundle: unknown, reference: unknown): Json | undefined {
  if (!isObj(bundle) || !Array.isArray(bundle.entry) || typeof reference !== 'string') return undefined
  for (const e of bundle.entry) {
    if (!isObj(e) || !isObj(e.resource)) continue
    const r = e.resource
    if (e.fullUrl === reference || `${r.resourceType}/${r.id}` === reference) return r
  }
  return undefined
}

export function parseClaimResponseBundle(bundle: unknown):
  | { ok: true; summary: NhcxResponseSummary; claimIdentifier: string | null; preAuthRef: string | null; dispositionText: string | null }
  | { ok: false; problem: string } {
  const resources = bundleResources(bundle)
  const cr = resources.find((r) => r.resourceType === 'ClaimResponse')
  if (!cr) return { ok: false, problem: 'No ClaimResponse in the bundle' }
  const totalOf = (code: string): number | null => {
    for (const t of Array.isArray(cr.total) ? cr.total.filter(isObj) : []) {
      if (codesOf(t.category).some((c) => c.code === code && (c.system === undefined || c.system === ADJUDICATION))) return fhirMoneyToPaise(t.amount)
    }
    return null
  }
  const reasons = new Set<string>()
  for (const item of Array.isArray(cr.item) ? cr.item.filter(isObj) : []) {
    for (const adj of Array.isArray(item.adjudication) ? item.adjudication.filter(isObj) : []) {
      for (const c of codesOf(adj.reason)) if (c.system === CS_ADJUDICATION_REASON && typeof c.code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(c.code)) reasons.add(c.code)
    }
  }
  const preAuthRef = typeof cr.preAuthRef === 'string' && cr.preAuthRef ? cr.preAuthRef : null
  const claim = byReference(bundle, isObj(cr.request) ? cr.request.reference : undefined) ?? resources.find((r) => r.resourceType === 'Claim')
  return {
    ok: true,
    summary: {
      ...emptySummary(),
      outcome: outcomeOf(cr.outcome),
      use: cr.use === 'claim' || cr.use === 'preauthorization' ? cr.use : null,
      submittedPaise: totalOf('submitted'),
      // 'eligpercent' (the S5 example) is not an approved amount; only 'benefit' is read (UNVERIFIED U15).
      benefitPaise: totalOf('benefit'),
      preAuthRefPresent: preAuthRef !== null,
      errorCodes: errorCodesOf(cr),
      adjudicationReasonCodes: [...reasons],
    },
    claimIdentifier: firstIdentifier(claim),
    preAuthRef,
    dispositionText: typeof cr.disposition === 'string' ? cr.disposition : null,
  }
}

function taskInput(bundle: unknown, type: string): Json | undefined {
  const task = bundleResources(bundle).find((r) => r.resourceType === 'Task')
  if (!task) return undefined
  for (const i of Array.isArray(task.input) ? task.input.filter(isObj) : []) {
    if (codesOf(i.type).some((c) => c.code === type) && isObj(i.valueReference)) return byReference(bundle, i.valueReference.reference)
  }
  return undefined
}

export function parseCommunicationRequestTaskBundle(bundle: unknown):
  | { ok: true; basedOnIdentifier: string | null; text: string; requestIdentifier: string | null; summary: NhcxResponseSummary }
  | { ok: false; problem: string } {
  const cr = taskInput(bundle, 'include') ?? bundleResources(bundle).find((r) => r.resourceType === 'CommunicationRequest')
  if (!cr || cr.resourceType !== 'CommunicationRequest') return { ok: false, problem: 'No CommunicationRequest in the bundle' }
  const text = (Array.isArray(cr.payload) ? cr.payload.filter(isObj) : []).map((p) => (typeof p.contentString === 'string' ? p.contentString : '')).filter(Boolean).join('\n')
  const basedOn = Array.isArray(cr.basedOn) && isObj(cr.basedOn[0]) ? byReference(bundle, cr.basedOn[0].reference) : undefined
  return { ok: true, basedOnIdentifier: firstIdentifier(basedOn), text, requestIdentifier: firstIdentifier(cr), summary: { ...emptySummary(), hasQueryText: text.length > 0 } }
}

export function parsePaymentNoticeTaskBundle(bundle: unknown):
  | { ok: true; summary: NhcxResponseSummary; paymentIdentifier: string | null }
  | { ok: false; problem: string } {
  const pn = taskInput(bundle, 'status') ?? bundleResources(bundle).find((r) => r.resourceType === 'PaymentNotice')
  if (!pn || pn.resourceType !== 'PaymentNotice') return { ok: false, problem: 'No PaymentNotice in the bundle' }
  const date = typeof pn.paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pn.paymentDate) ? pn.paymentDate : null
  return { ok: true, summary: { ...emptySummary(), paymentAmountPaise: fhirMoneyToPaise(pn.amount), paymentDate: date }, paymentIdentifier: firstIdentifier(pn) }
}

function withoutContact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutContact)
  if (!isObj(v)) return v
  // Narratives (text.div) are dropped too: the insurer's renderings repeat phone numbers and addresses.
  return Object.fromEntries(Object.entries(v)
    .filter(([k, x]) => k !== 'telecom' && k !== 'address' && !(k === 'text' && isObj(x) && 'div' in x))
    .map(([k, x]) => [k, withoutContact(x)]))
}

function taskBundle(task: FhirResource, rest: FhirBundleEntry[], created: string): FhirBundle {
  const id = newId()
  return { resourceType: 'Bundle', id, meta: { profile: [PROFILE.TaskBundle] }, identifier: { value: id }, type: 'collection', timestamp: created, entry: [entry(task), ...rest] }
}

/** The reply to an insurer query: Task deliver -> Communication, echoing the request bundle's resources. */
export function buildCommunicationResponseTaskBundle(i: {
  request: { identifier: string; fullBundle: unknown }
  text: string
  attachments: { contentType: string; title: string; dataBase64?: string }[]
  created: Date
  hospital: SnapshotHospital
  payer: PayerRef
}): FhirBundle {
  const created = istIsoWithOffset(i.created)
  const ids = { task: newId(), comm: newId(), hospital: newId(), payer: newId() }
  // The insurer's resources are echoed for context, without contact or address data (spec §3).
  const echoed = (isObj(i.request.fullBundle) && Array.isArray(i.request.fullBundle.entry) ? i.request.fullBundle.entry : [])
    .filter((e): e is FhirBundleEntry => isObj(e) && typeof e.fullUrl === 'string' && isObj(e.resource) && e.resource.resourceType !== 'Task')
    .map((e) => ({ fullUrl: e.fullUrl, resource: withoutContact(e.resource) as FhirResource }))
  const commRequest = echoed.find((e) => e.resource.resourceType === 'CommunicationRequest')
  const communication: FhirResource = {
    resourceType: 'Communication', id: ids.comm, meta: { profile: [PROFILE.Communication] },
    identifier: [{ value: i.request.identifier }],
    ...(commRequest ? { basedOn: [{ reference: commRequest.fullUrl }] } : {}),
    status: 'completed',
    category: [{ coding: [{ system: COMM_CATEGORY, code: 'notification' }] }],
    sent: created,
    recipient: [ref(ids.payer)], sender: ref(ids.hospital),
    payload: [
      ...(i.text ? [{ contentString: i.text }] : []),
      ...i.attachments.map((a) => ({ contentAttachment: { contentType: a.contentType, title: a.title, ...(a.dataBase64 ? { data: a.dataBase64 } : {}) } })),
    ],
  }
  const task: FhirResource = {
    resourceType: 'Task', id: ids.task, meta: { profile: [PROFILE.Task] }, status: 'completed', intent: 'order',
    code: { coding: [{ system: CS_TASK_CODES, code: 'deliver' }] }, authoredOn: created,
    requester: ref(ids.hospital), owner: ref(ids.payer),
    input: [{ type: { coding: [{ system: FINANCIAL_TASK_INPUT, code: 'include' }] }, valueReference: ref(ids.comm) }],
  }
  return taskBundle(task, [entry(communication), entry(nhcxHospital(i.hospital, ids.hospital)), entry(nhcxPayer(i.payer, ids.payer)), ...echoed], created)
}

/** The payment acknowledgement (S5 TaskBundleForPaymentNoticeResponse). */
export function buildPaymentAckTaskBundle(i: { created: Date; hospital: SnapshotHospital; payer: PayerRef }): FhirBundle {
  const created = istIsoWithOffset(i.created)
  const ids = { task: newId(), hospital: newId(), payer: newId() }
  const task: FhirResource = {
    resourceType: 'Task', id: ids.task, meta: { profile: [PROFILE.Task] }, status: 'completed', intent: 'order',
    code: { coding: [{ system: FINANCIAL_TASK_CODE, code: 'status' }] }, authoredOn: created,
    requester: ref(ids.hospital), owner: ref(ids.payer),
    output: [{
      type: { coding: [{ system: CS_TASK_OUTPUT_TYPE, code: 'status' }] },
      valueCodeableConcept: { coding: [{ system: CS_TASK_OUTPUT_VALUE, code: 'paymentack', display: 'Payment is acknowledged' }] },
    }],
  }
  return taskBundle(task, [entry(nhcxHospital(i.hospital, ids.hospital)), entry(nhcxPayer(i.payer, ids.payer))], created)
}

/** A status request (HCX /v1/status; payload shape UNVERIFIED U9): a Task asking for the status of a correlation. */
export function buildStatusTaskBundle(i: { created: Date; sender: string; recipient: string; correlationId: string }): FhirBundle {
  const created = istIsoWithOffset(i.created)
  const task: FhirResource = {
    resourceType: 'Task', id: newId(), meta: { profile: [PROFILE.Task] }, status: 'requested', intent: 'order',
    code: { coding: [{ system: FINANCIAL_TASK_CODE, code: 'status' }] }, authoredOn: created,
    focus: { identifier: { value: i.correlationId } },
    requester: { identifier: { value: i.sender } }, owner: { identifier: { value: i.recipient } },
  }
  return taskBundle(task, [], created)
}
