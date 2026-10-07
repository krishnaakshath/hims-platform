// Service catalogue <-> procedure-code compatibility and the SP4 charge-code check (SP6 Task 14).
// Pure and client-safe. The map is version-independent (kind + code value, ruling 15): it is
// validated against the kind's current version when written, and a service with no mapping is
// unconstrained, so SP4 can roll the charge check out gradually.
import { CODE_SYSTEM_LABEL, normalizeCode, type CodeSystemKind } from '@/lib/coding/code-systems'
import type { ServiceCategory } from '@/lib/tariff/validation'

/** Which code kinds a service of each category may carry; categories absent here carry none. */
export const SERVICE_CODE_KINDS_BY_CATEGORY: Partial<Record<ServiceCategory, readonly CodeSystemKind[]>> = {
  procedure: ['icd10pcs', 'snomed', 'hbp'],
  package: ['hbp'],
  investigation_lab: ['loinc'],
  investigation_imaging: ['snomed', 'icd10pcs'],
}

/** Reader-facing names of the mappable categories (used in problem messages and the page). */
export const MAPPABLE_CATEGORY_LABEL: Partial<Record<ServiceCategory, string>> = {
  procedure: 'procedure',
  package: 'package',
  investigation_lab: 'lab investigation',
  investigation_imaging: 'imaging investigation',
}

export const MAPPABLE_SERVICE_CATEGORIES = Object.keys(SERVICE_CODE_KINDS_BY_CATEGORY) as ServiceCategory[]

export function isMappableServiceCategory(category: ServiceCategory): boolean {
  return SERVICE_CODE_KINDS_BY_CATEGORY[category] !== undefined
}

export const UNMAPPABLE_SERVICE_MESSAGE = 'This kind of service cannot carry procedure codes'

const withArticle = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`)

/**
 * Problems with mapping `codes` to a service of `category`: one message for a category that carries
 * no codes, else one per distinct code kind that does not fit. An empty list (clearing) is fine.
 */
export function serviceCodeProblems(category: ServiceCategory, codes: { kind: CodeSystemKind; code: string }[]): string[] {
  if (codes.length === 0) return []
  const allowed = SERVICE_CODE_KINDS_BY_CATEGORY[category]
  if (!allowed) return [UNMAPPABLE_SERVICE_MESSAGE]
  const bad = [...new Set(codes.map((c) => c.kind).filter((k) => !allowed.includes(k)))]
  const service = `${withArticle(MAPPABLE_CATEGORY_LABEL[category] ?? category)} service`
  return bad.map((k) => `${CODE_SYSTEM_LABEL[k]} codes do not fit ${service}`)
}

/**
 * For SP4 charge capture: the problems with charging `requested` procedure codes against a service
 * whose map is `mapped`. An unmapped service (empty `mapped`) is unconstrained (ruling 15) and
 * yields []; otherwise one message per requested code (kind + normalised value) not in the map.
 */
export function chargeProcedureCodeProblems(
  mapped: { kind: CodeSystemKind; code: string }[],
  requested: { kind: CodeSystemKind; code: string }[],
): string[] {
  if (mapped.length === 0) return []
  const key = (c: { kind: CodeSystemKind; code: string }) => `${c.kind}:${normalizeCode(c.code)}`
  const allowed = new Set(mapped.map(key))
  return requested.filter((r) => !allowed.has(key(r))).map((r) => `${normalizeCode(r.code)} is not a procedure code mapped to this service`)
}
