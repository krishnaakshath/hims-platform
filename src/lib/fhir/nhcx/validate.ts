// Structural validator for NHCX bundles, from the minimum required elements of
// the NRCeS FHIR IG for ABDM, package ndhm.in 6.5.0 (S5). It is not a full
// FHIR validator (the optional HAPI step in docs/ABDM-NHCX.md is); it checks
// the things that would make a bundle unusable or unlawful to send.

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export const REQUIRED_PATHS: Record<string, string[]> = {
  Claim: ['identifier', 'status', 'type', 'use', 'patient', 'created', 'insurer', 'provider', 'priority', 'diagnosis', 'insurance', 'item'],
  CoverageEligibilityRequest: ['status', 'purpose', 'patient', 'created', 'insurer', 'insurance'],
  Coverage: ['status', 'beneficiary', 'payor'],
  Patient: ['identifier', 'name'],
  Organization: ['identifier', 'name'],
  Practitioner: ['identifier', 'name'],
  Communication: ['status'],
  CommunicationRequest: ['status'],
  PaymentNotice: ['status', 'created', 'payment', 'recipient', 'amount'],
  Task: ['status', 'intent'],
}

/** The national ID number (type ADN, issuer uidai) is never sent (spec §3); src/lib/fhir may not even name it. */
export const NATIONAL_ID_PROBLEM = 'National ID (ADN) identifiers must never be sent'

export type BundleProfile = 'ClaimBundle' | 'CoverageEligibilityRequestBundle' | 'TaskBundle'

const FIRST: Record<BundleProfile, { type: string; exactlyOne: boolean }> = {
  ClaimBundle: { type: 'Claim', exactlyOne: false },
  CoverageEligibilityRequestBundle: { type: 'CoverageEligibilityRequest', exactlyOne: true },
  TaskBundle: { type: 'Task', exactlyOne: true },
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

function walk(v: unknown, path: string, visit: (node: Json, path: string) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, path, visit)
  } else if (isObj(v)) {
    visit(v, path)
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, visit)
  }
}

function codingsAt(r: Json, keys: string[]): unknown[] {
  let nodes: unknown[] = [r]
  for (const k of keys) nodes = nodes.flatMap((n) => (isObj(n) ? (Array.isArray(n[k]) ? (n[k] as unknown[]) : n[k] === undefined ? [] : [n[k]]) : []))
  return nodes
}

const CODED_PATHS: [string, string[]][] = [
  ['item.productOrService.coding', ['item', 'productOrService', 'coding']],
  ['diagnosis.type.coding', ['diagnosis', 'type', 'coding']],
  ['supportingInfo.category.coding', ['supportingInfo', 'category', 'coding']],
  ['supportingInfo.code.coding', ['supportingInfo', 'code', 'coding']],
]

export function validateNhcxBundle(bundle: unknown, profile: BundleProfile): string[] {
  const problems: string[] = []
  if (!isObj(bundle) || bundle.resourceType !== 'Bundle') return ['Not a FHIR Bundle']
  if (bundle.type !== 'collection') problems.push('Bundle.type must be collection')
  if (!isObj(bundle.identifier) || !present(bundle.identifier.value)) problems.push('Bundle.identifier is required')
  // The official TaskBundle PaymentNotice example has no timestamp, so it is required only for the request bundles.
  if (profile !== 'TaskBundle' && !present(bundle.timestamp)) problems.push('Bundle.timestamp is required')
  const entries = Array.isArray(bundle.entry) ? bundle.entry.filter(isObj) : []
  if (entries.length === 0) return [...problems, 'Bundle.entry is required']

  const resources = entries.map((e) => (isObj(e.resource) ? e.resource : null))
  const first = FIRST[profile]
  const firstType = resources[0]?.resourceType
  const count = resources.filter((r) => r?.resourceType === first.type).length
  if (firstType !== first.type || (first.exactlyOne && count !== 1)) problems.push(`${profile} must start with ${first.exactlyOne ? 'exactly one' : 'a'} ${first.type}`)

  const targets = new Set<string>()
  for (const [i, e] of entries.entries()) {
    if (typeof e.fullUrl === 'string') targets.add(e.fullUrl)
    const r = resources[i]
    if (r && typeof r.resourceType === 'string' && typeof r.id === 'string') targets.add(`${r.resourceType}/${r.id}`)
  }

  let nationalId = false
  for (const r of resources) {
    if (!r || typeof r.resourceType !== 'string') { problems.push('Every entry needs a resource'); continue }
    const t = r.resourceType
    for (const p of REQUIRED_PATHS[t] ?? []) if (!present(r[p])) problems.push(`${t}.${p} is required`)
    walk(r, t, (node, path) => {
      if (typeof node.reference === 'string' && !targets.has(node.reference)) problems.push(`${path} references ${node.reference}, which is not in the bundle`)
      if (Array.isArray(node.identifier)) {
        for (const id of node.identifier) {
          if (!isObj(id)) continue
          const codes = codingsAt(id, ['type', 'coding']).map((c) => (isObj(c) ? c.code : null))
          if (codes.includes('ADN') || (typeof id.system === 'string' && /uidai/i.test(id.system))) nationalId = true
        }
      }
    })
    if (t === 'Claim') {
      for (const [label, keys] of CODED_PATHS) {
        for (const c of codingsAt(r, keys)) if (!isObj(c) || !present(c.system) || !present(c.code)) problems.push(`Claim.${label} needs system and code`)
      }
    }
  }
  if (nationalId) problems.push(NATIONAL_ID_PROBLEM)
  return [...new Set(problems)]
}
